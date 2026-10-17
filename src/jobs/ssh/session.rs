//! A batch shell keeps Win32-OpenSSH operations on one authenticated transport.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use super::{sh_quote, ssh_opts, SshTarget};
use crate::error::{anyhow, Result};

// Length framing preserves binary archives, partial log lines, and arbitrary command output.
const WORKER: &str = r#"set -e
umask 077
work=$(mktemp -d) || exit 1
trap 'rm -rf -- "$work"' EXIT
printf 'ORX_SSH_READY\n'
while read -r command_size input_size; do
    head -c "$command_size" > "$work/command"
    test "$(wc -c < "$work/command")" -eq "$command_size" || exit 1
    head -c "$input_size" > "$work/input"
    test "$(wc -c < "$work/input")" -eq "$input_size" || exit 1
    if bash -c "$(cat "$work/command")" < "$work/input" > "$work/out" 2> "$work/err"; then
        code=0
    else
        code=$?
    fi
    printf '%s %s %s\n' "$code" "$(wc -c < "$work/out")" "$(wc -c < "$work/err")"
    cat "$work/out" "$work/err"
done
"#;

type Key = (String, Vec<String>);
type Slot = Arc<Mutex<Option<Session>>>;
static SESSIONS: OnceLock<Mutex<HashMap<Key, Slot>>> = OnceLock::new();

pub(super) async fn run(
    target: &SshTarget,
    command: &str,
    input: &mut (dyn AsyncRead + Unpin + Send),
    size: u64,
) -> Result<String> {
    let slot = SESSIONS
        .get_or_init(Mutex::default)
        .lock()
        .await
        .entry((target.dest.clone(), target.extra_opts.clone()))
        .or_default()
        .clone();
    let mut slot = slot.lock().await;
    // A cancelled request must drop its transport, not leave a half-read reply in the pool.
    let mut session = match slot.take() {
        Some(session) => session,
        None => connect(target).await?,
    };
    match session.request(command, input, size).await {
        Ok(reply) => {
            *slot = Some(session);
            if reply.code != 0 {
                return Err(anyhow!(
                    "ssh {} failed (exit {}): {}",
                    target.dest,
                    reply.code,
                    String::from_utf8_lossy(&reply.stderr).trim()
                ));
            }
            Ok(String::from_utf8_lossy(&reply.stdout).into_owned())
        }
        // Never replay a submitted command: it could already have launched a job.
        Err(error) => Err(session.failure(&target.dest, error).await),
    }
}

async fn connect(target: &SshTarget) -> Result<Session> {
    for attempt in 0..4 {
        let result = Session::start(target).await;
        match result {
            Ok(session) => return Ok(session),
            Err(error) if attempt < 3 && connect_timeout(&error.to_string()) => {
                let delay = Duration::from_secs(30 << attempt);
                eprintln!(
                    "SSH connection to {} timed out; retrying in {}s before sending any command.",
                    target.dest,
                    delay.as_secs()
                );
                tokio::time::sleep(delay).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

fn connect_timeout(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("timed out") || error.contains("connection timeout")
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct Reply {
    code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Session {
    async fn start(target: &SshTarget) -> Result<Self> {
        let mut child = Command::new("ssh")
            .env("ORX_SSH_PROBE", "1")
            .args(ssh_opts(target, true))
            .args(["-T", "--", &target.dest])
            .arg(format!("bash -c {}", sh_quote(WORKER)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| anyhow!("Could not run ssh: {error}"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut session = Self {
            child,
            stdin,
            stdout,
        };
        let ready = tokio::time::timeout(Duration::from_secs(45), session.ready()).await;
        match ready {
            Ok(Ok(())) => Ok(session),
            other => {
                let error = match other {
                    Ok(Err(error)) => error,
                    Err(_) => anyhow!("SSH connection timed out waiting for the batch shell"),
                    Ok(Ok(())) => unreachable!(),
                };
                Err(session.failure(&target.dest, error).await)
            }
        }
    }

    async fn ready(&mut self) -> Result<()> {
        let mut line = String::new();
        self.stdout.read_line(&mut line).await?;
        if line != "ORX_SSH_READY\n" {
            return Err(anyhow!("SSH batch shell did not start"));
        }
        Ok(())
    }

    async fn request(
        &mut self,
        command: &str,
        input: &mut (dyn AsyncRead + Unpin + Send),
        size: u64,
    ) -> Result<Reply> {
        self.stdin
            .write_all(format!("{} {size}\n", command.len()).as_bytes())
            .await?;
        self.stdin.write_all(command.as_bytes()).await?;
        if tokio::io::copy(&mut input.take(size), &mut self.stdin).await? != size {
            return Err(anyhow!("SSH input ended before its declared length"));
        }
        self.stdin.flush().await?;
        let mut header = String::new();
        self.stdout.read_line(&mut header).await?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 {
            return Err(anyhow!("SSH batch shell returned an invalid response"));
        }
        let code = fields[0].parse()?;
        let stdout = self.read_body(fields[1].parse()?).await?;
        let stderr = self.read_body(fields[2].parse()?).await?;
        Ok(Reply {
            code,
            stdout,
            stderr,
        })
    }

    async fn read_body(&mut self, size: u64) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        let read = (&mut self.stdout)
            .take(size)
            .read_to_end(&mut bytes)
            .await?;
        if read as u64 != size {
            return Err(anyhow!("SSH batch shell response was interrupted"));
        }
        Ok(bytes)
    }

    async fn failure(mut self, dest: &str, error: anyhow::Error) -> anyhow::Error {
        let _ = self.child.kill().await;
        let stderr = self
            .child
            .wait_with_output()
            .await
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stderr).trim().to_string())
            .unwrap_or_default();
        anyhow!(
            "ssh {dest}: {error}{separator}{stderr}",
            separator = if stderr.is_empty() { "" } else { ": " }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_connection_timeouts_are_retryable_before_submission() {
        assert!(connect_timeout(
            "Connection timed out during banner exchange"
        ));
        assert!(connect_timeout(
            "ssh: connect to host box port 22: Connection timed out"
        ));
        for message in [
            "Permission denied (publickey)",
            "Host key verification failed",
            "Connection refused",
            "SSH batch shell did not start",
        ] {
            assert!(!connect_timeout(message));
        }
    }

    #[tokio::test]
    #[ignore = "requires a real SSH host; set ORX_SSH_TEST_HOST"]
    async fn real_ssh_reuses_one_shell_across_commands_and_remote_failures() {
        let target = SshTarget::alias(&std::env::var("ORX_SSH_TEST_HOST").unwrap());
        let call = |command: &'static str| {
            let target = target.clone();
            async move { run(&target, command, &mut &b""[..], 0).await }
        };
        let first = call("echo $PPID").await.unwrap();
        assert!(call("echo expected_error >&2; exit 42")
            .await
            .unwrap_err()
            .to_string()
            .contains("expected_error"));
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..12 {
            requests.spawn(call("echo $PPID"));
        }
        while let Some(result) = requests.join_next().await {
            assert_eq!(result.unwrap().unwrap(), first);
        }
        let data = b"\0\xff\nORX_SSH_READY\n0 0 0\n";
        assert_eq!(
            run(&target, "wc -c", &mut &data[..], data.len() as u64)
                .await
                .unwrap()
                .trim(),
            data.len().to_string()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn batch_shell_preserves_binary_input_failures_and_response_boundaries() {
        let mut child = Command::new("bash")
            .args(["-c", WORKER])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut session = Session {
            stdin: child.stdin.take().unwrap(),
            stdout: BufReader::new(child.stdout.take().unwrap()),
            child,
        };
        session.ready().await.unwrap();
        let data = b"\0\xff\nORX_SSH_READY\n0 0 0\n";
        let reply = session
            .request(
                "cat; printf 'failure without newline' >&2; exit 42",
                &mut &data[..],
                data.len() as u64,
            )
            .await
            .unwrap();
        assert_eq!(reply.code, 42);
        assert_eq!(reply.stdout, data);
        assert_eq!(reply.stderr, b"failure without newline");
        let reply = session
            .request("printf 'second\n\u{2713}'", &mut &b""[..], 0)
            .await
            .unwrap();
        assert_eq!(reply.code, 0);
        assert_eq!(reply.stdout, "second\n\u{2713}".as_bytes());
        session.child.kill().await.unwrap();
    }
}

import { useCallback, useEffect, useState } from "react";
import { m } from "../paraglide/messages.js";
import { htmlFigureAssetTarget, isExternalMarkdownTarget } from "../markdownTarget";
import { HtmlPreview } from "./HtmlPreview";

export function InlineHtmlFigure({ source, urls, name, resolveSrc }: {
  source: string;
  urls: string[];
  name: string;
  resolveSrc: (src: string) => string[];
}) {
  const [document, setDocument] = useState<{ html: string; url: string; attempt: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setDocument(null);
    setError(false);
    async function load() {
      for (const [attempt, candidate] of urls.entries()) {
        try {
          const response = await fetch(candidate, { signal: controller.signal });
          if (!response.ok || !response.headers.get("content-type")?.startsWith("text/html")) continue;
          const html = await response.text();
          if (!controller.signal.aborted) setDocument({ html, url: candidate, attempt });
          return;
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (!controller.signal.aborted) setError(true);
    }
    void load();
    return () => controller.abort();
  }, [urls]);
  const resolveAsset = useCallback((src: string) => {
    if (isExternalMarkdownTarget(src)) return src;
    const target = htmlFigureAssetTarget(source, src);
    if (!target) return null;
    const candidates = resolveSrc(target);
    return candidates[document?.attempt ?? 0] ?? candidates[0] ?? null;
  }, [source, resolveSrc, document?.attempt]);
  return <div className="inline-html-figure my-2 w-full min-w-0">
    {document ? <HtmlPreview html={document.html} truncated={false} url={document.url} name={name} resolveSrc={resolveAsset} fitContent />
      : <div className="flex h-90 items-center justify-center text-sm text-subtext">
        {error ? <a href={urls[0]} target="_blank" rel="noopener noreferrer">{m.file_viewer_failed_to_load_file()}</a> : m.file_viewer_loading()}
      </div>}
  </div>;
}

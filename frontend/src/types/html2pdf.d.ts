// Minimal ambient declaration for html2pdf.js (no first-party types).
// We type the surface we actually use; everything else stays opaque.
declare module 'html2pdf.js' {
  interface Html2PdfWorker {
    set(opts: unknown): Html2PdfWorker;
    from(el: HTMLElement | string): Html2PdfWorker;
    save(): Promise<void>;
    toPdf(): Html2PdfWorker;
    output(type?: string, options?: unknown): Promise<unknown>;
  }
  const html2pdf: () => Html2PdfWorker;
  export default html2pdf;
}

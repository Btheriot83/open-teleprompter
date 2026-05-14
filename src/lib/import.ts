export async function importFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt') || file.type === 'text/plain') {
    return await file.text();
  }
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    return await importPdf(file);
  }
  if (
    name.endsWith('.docx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return await importDocx(file);
  }
  throw new Error(`Unsupported file type: ${file.name}`);
}

async function importPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  // Worker as URL — Vite handles this
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push(text);
  }
  return pages.join('\n\n');
}

async function importDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth/mammoth.browser.js');
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

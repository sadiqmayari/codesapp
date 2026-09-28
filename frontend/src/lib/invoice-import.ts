import { postMultipart } from '@/lib/api';

export interface InvoiceImportResult {
  totalStamped: number;
  totalParsed: number;
  unmatched: string[];
  perFile: Array<{
    file: string;
    courier: string | null;
    parsed: number;
    stamped: number;
    unmatched: number;
    error?: string;
  }>;
}

/** Upload one or more courier statement files → stamp invoice numbers on orders. */
export function importInvoiceStatements(files: File[]) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return postMultipart<InvoiceImportResult>('/settings/invoice-import', fd);
}

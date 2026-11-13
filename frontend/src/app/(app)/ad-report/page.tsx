import { redirect } from 'next/navigation';

/** The Ad Report was renamed to Growth (Nov-2026); keep old links working. */
export default function AdReportRedirect() {
  redirect('/growth');
}

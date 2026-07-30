/** Formats a Date as its billing period, 'YYYY-MM'. */
export function formatPeriod(date: Date): string {
  const year = date.getFullYear();
  // getMonth() is 0-indexed (0 = January), so add 1 for the calendar month.
  const month = date.getMonth() + 1;
  const paddedMonth = String(month).padStart(2, '0');
  return `${year}-${paddedMonth}`;
}

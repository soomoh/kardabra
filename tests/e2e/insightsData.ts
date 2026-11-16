/**
 * Four months of one synthetic card (Jul–Oct 2025) in the HDFC-style CSV
 * layout, shaped to fill every Insights section: a monthly subscription
 * with a price rise, one that started within the data, fees, interest,
 * forex markup, cashback, a high credit balance, and a doubled charge.
 * Fabricated amounts and merchants; shared by the e2e and visual specs.
 */

type Line = [day: string, payee: string, amount: number, side: 'Dr' | 'Cr'];

function statement(
  month: number,
  totalDue: number,
  lines: Line[],
): { name: string; mimeType: string; buffer: Buffer } {
  const mm = String(month).padStart(2, '0');
  const next = String(month + 1).padStart(2, '0');
  const money = (n: number) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2 });
  const text = [
    `Statement Date~13/${mm}/2025`,
    `Payment Due Date~02/${next}/2025`,
    `Total Amount Due~${money(totalDue)}`,
    `Minimum Amount Due~${money(Math.round(totalDue * 5) / 100)}`,
    'Credit Limit~2,00,000.00',
    'Card Number~4823 41XX XXXX 4321',
    '',
    'Date~Transaction Details~Amount~Debit/Credit',
    ...lines.map(
      ([day, payee, amount, side]) =>
        `${day}~${payee}~${money(amount)}~${side}`,
    ),
  ].join('\n');
  return {
    name: `hdfc_2025_${mm}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(text + '\n'),
  };
}

export const insightsStatements = [
  statement(7, 6449, [
    ['15/06/2025', 'PAYMENT RECEIVED THANK YOU', 5200, 'Cr'],
    ['18/06/2025', 'NETFLIX.COM', 499, 'Dr'],
    ['21/06/2025', 'SWIGGY BANGALORE', 1450, 'Dr'],
    ['02/07/2025', 'AMAZON RETAIL BLR', 4500, 'Dr'],
  ]),
  statement(8, 5248, [
    ['15/07/2025', 'PAYMENT RECEIVED THANK YOU', 6449, 'Cr'],
    ['18/07/2025', 'NETFLIX.COM', 499, 'Dr'],
    ['20/07/2025', 'SPOTIFY INDIA', 119, 'Dr'],
    ['24/07/2025', 'SWIGGY BANGALORE', 2130, 'Dr'],
    ['05/08/2025', 'AMAZON RETAIL BLR', 2500, 'Dr'],
    ['09/08/2025', 'WWWBIGBASKETCOM', 1240, 'Dr'],
    ['12/08/2025', '1.75% on all DCC Transaction', 42.5, 'Dr'],
  ]),
  statement(9, 4598, [
    ['15/08/2025', 'PAYMENT RECEIVED THANK YOU', 5248, 'Cr'],
    ['18/08/2025', 'NETFLIX.COM', 499, 'Dr'],
    ['20/08/2025', 'SPOTIFY INDIA', 119, 'Dr'],
    ['27/08/2025', 'SWIGGY BANGALORE', 980, 'Dr'],
    ['03/09/2025', 'AMAZON RETAIL BLR', 3200, 'Dr'],
    ['04/09/2025', 'AMAZON RETAIL BLR', 200, 'Cr'],
    ['08/09/2025', 'WWWBIGBASKETCOMGURGOAN', 980, 'Dr'],
    ['12/09/2025', '1.75% on all DCC Transaction', 42.5, 'Dr'],
  ]),
  statement(10, 72641.25, [
    ['15/09/2025', 'PAYMENT RECEIVED THANK YOU', 4000, 'Cr'],
    ['18/09/2025', 'NETFLIX.COM', 649, 'Dr'],
    ['20/09/2025', 'SPOTIFY INDIA', 119, 'Dr'],
    ['22/09/2025', 'CROMA ELECTRONICS MUMBAI', 65000, 'Dr'],
    ['25/09/2025', 'COOL COFFEE BANGALORE', 320, 'Dr'],
    ['25/09/2025', 'COOL COFFEE BANGALORE', 320, 'Dr'],
    ['28/09/2025', 'SWIGGY BANGALORE', 1720, 'Dr'],
    ['30/09/2025', 'HOTEL LISBOA PT', 3800, 'Dr'],
    ['30/09/2025', 'CONSOLIDATED FCY MARKUP FEE', 133, 'Dr'],
    ['30/09/2025', 'GST ON FOREX MARKUP', 23.94, 'Dr'],
    ['03/10/2025', 'LATE PAYMENT FEE', 700, 'Dr'],
    ['03/10/2025', 'IGST ON LATE FEE', 126, 'Dr'],
    ['10/10/2025', 'FINANCE CHARGES', 450, 'Dr'],
    ['10/10/2025', 'RENEWAL MEMBERSHIP FEE', 499, 'Dr'],
    ['12/10/2025', '1.75% on all DCC Transaction', 42.5, 'Dr'],
    ['11/10/2025', 'CASHBACK CREDIT', 50, 'Cr'],
  ]),
];

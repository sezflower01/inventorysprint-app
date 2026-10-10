/**
 * Would any cell render as ###### ?
 *
 * The first plain export fixed the month columns at 11 characters, and
 * "($45,512.61)" is twelve. Excel does not wrap or clip a numeric cell, it
 * replaces it with ######, so the rows that masked were exactly the big ones:
 * Total Expenses, COGS, Total Operating Expenses, Total Amazon Fees, Referral
 * Fees, FBA Fulfilment Fees. Every ordinary line stayed readable, which is why
 * it was not obvious.
 *
 * This replays the real magnitudes through the same width calculation the
 * export now uses, and asserts every column is wide enough for its own widest
 * value.
 */
const ExcelJS = require('exceljs');

const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Real shapes from the live P&L, negatives included.
const rows = [
  ['Profit & Loss 2026'],
  ['Reconciled'],
  ['INCOME'],
  ['Category', ...months, 'TOTAL'],
  ['Sales', ...months.map((_, i) => 75000 + i * 1000), 905612.55],
  ['EXPENSES (Amazon Fees)'],
  ['Referral Fees', ...months.map(() => -11000.25), -137323.78],
  ['FBA Fulfilment Fees', ...months.map(() => -9800.5), -117606.0],
  ['TOTAL EXPENSES', ...months.map(() => -45512.61), -367851.18],
  ['COST OF GOODS SOLD'],
  ['TOTAL COGS', ...months.map(() => -38920.96), -467051.52],
  ['OPERATING EXPENSES (by Category)'],
  ['TOTAL OPERATING EXPENSES', ...months.map(() => -1234.56), -14814.72],
  ['NET PROFIT/LOSS', ...months.map(() => -1500.11), -1234567.89],
];

const formattedWidth = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '').length;
  const body = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return 1 + body.length + (v < 0 ? 2 : 0);
};

(async () => {
  const totalCols = 1 + months.length + 1;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('P&L by Month', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  rows.forEach(r => ws.addRow(r));

  const widest = new Array(totalCols).fill(0);
  rows.forEach((row) => {
    for (let c = 0; c < totalCols; c++) {
      if (c >= row.length) continue;
      widest[c] = Math.max(widest[c], formattedWidth(row[c]));
    }
  });
  ws.getColumn(1).width = Math.min(Math.max(widest[0] + 2, 18), 38);
  for (let i = 2; i <= totalCols; i++) ws.getColumn(i).width = Math.max(widest[i - 1] + 2, 10);

  // What the OLD fixed widths would have done, for comparison.
  const OLD = { label: 34, month: 11, total: 13 };

  console.log('col | widest value | new width | old width | old masked?');
  let masked = 0, newMasked = 0, totalWidth = 0;
  for (let c = 0; c < totalCols; c++) {
    const need = widest[c];
    const oldW = c === 0 ? OLD.label : (c === totalCols - 1 ? OLD.total : OLD.month);
    const newW = ws.getColumn(c + 1).width;
    totalWidth += newW;
    const wouldMask = need > oldW;
    if (wouldMask) masked++;
    if (need > newW) newMasked++;
    if (c === 0 || c === 1 || c === totalCols - 1 || wouldMask) {
      console.log(`${String(c + 1).padStart(3)} | ${String(need).padStart(12)} | ${String(newW).padStart(9)} | ${String(oldW).padStart(9)} | ${wouldMask ? 'YES ######' : 'no'}`);
    }
  }

  console.log(`\nold fixed widths would have masked ${masked} of ${totalCols} columns`);
  console.log(`new measured widths mask ${newMasked} columns`);
  console.log(`total sheet width: ${totalWidth} chars (old would have been ${OLD.label + months.length * OLD.month + OLD.total})`);

  if (newMasked > 0) { console.error('FAIL: a column is still too narrow'); process.exit(1); }
  if (masked === 0) { console.error('FAIL: the test data does not reproduce the reported masking'); process.exit(1); }
  console.log('\nOK: every column fits its widest value, and the reported masking is reproduced on the old widths.');
})();

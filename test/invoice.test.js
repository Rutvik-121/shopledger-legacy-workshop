const test = require('node:test');
const assert = require('node:assert/strict');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const orders = require('../lib/orders');
const ledger = require('../lib/ledger');

// All fixtures are in memory. Do not load the server, routes, or file store.
function item(overrides = {}) {
  return { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 1, ...overrides };
}

function figures(items, coupon = '') {
  return invoice.computeInvoiceFigures({ items, coupon });
}

test('CURRENT BEHAVIOUR: empty and missing items produce zero invoice figures', () => {
  const expected = { subtotal: 0, discount: 0, tax: 0, cgst: 0, sgst: 0, total: 0, rows: [] };
  assert.deepEqual(invoice.computeInvoiceFigures({}), expected);
  assert.deepEqual(figures([]), expected);
});

test('invoice uses the same HSN slabs as billing', () => {
  const items = [item(), item({ id: 2, hsn: '0405' }), item({ id: 3, hsn: '0902' })];
  const billed = pricing.computeTotals(items, '');
  assert.deepEqual(billed.lines.map(line => line.gstPercent), [5, 12, 18]);
  assert.deepEqual([billed.subtotal, billed.tax, billed.cgst, billed.sgst, billed.total], [300, 35, 17.5, 17.5, 335]);
  assert.deepEqual(figures(items), {
    subtotal: 300, discount: 0, tax: 35, cgst: 17.5, sgst: 17.5, total: 335,
    rows: items.map((it, index) => ({ name: it.name, sku: it.sku, hsn: it.hsn, qty: 1, price: 100, gstPercent: [5, 12, 18][index], line: 100, lineTax: [5, 12, 18][index] }))
  });
});

for (const [rate, billedTax, invoiceTax, invoicePercent] of [
  [5, 5, 5, 5], [0.05, 5, 5, 5], [0, 0, 0, 0], ['5', 5, 5, 5], ['0', 5, 5, 5]
]) {
  test(`invoice and billing: gstRate ${JSON.stringify(rate)} (${typeof rate}) yields billed tax ${billedTax} and invoice tax ${invoiceTax}`, () => {
    const items = [item({ gstRate: rate })];
    assert.equal(pricing.computeTotals(items, '').tax, billedTax);
    const actual = figures(items);
    assert.equal(actual.tax, invoiceTax);
    assert.equal(actual.rows[0].gstPercent, invoicePercent);
  });
}

test('percentage coupon and post-discount GST match billing', () => {
  const items = [item({ price: 1000 })];
  const billed = pricing.computeTotals(items, 'SAVE10');
  assert.deepEqual([billed.subtotal, billed.discount, billed.taxable, billed.tax, billed.total], [1000, 100, 900, 45, 945]);
  const actual = figures(items, 'SAVE10');
  assert.deepEqual([actual.subtotal, actual.discount, actual.tax, actual.total], [1000, 100, 45, 945]);
});

test('flat coupon reduces taxable value consistently with billing', () => {
  const items = [item({ price: 500, gstRate: 18 })];
  const billed = pricing.computeTotals(items, 'FLAT50');
  const actual = figures(items, 'FLAT50');
  assert.deepEqual([billed.discount, billed.tax, billed.total], [50, 81, 531]);
  assert.deepEqual([actual.discount, actual.tax, actual.total], [50, 81, 531]);
});

for (const [code, price, billedDiscount, invoiceDiscount, invoiceTotal] of [
  ['SAVE10', 100, 0, 0, 105], // Below minimum.
  ['SAVE10', 2000, 150, 150, 1942.5], // Above discount cap.
  ['DIWALI20', 1000, 0, 0, 1050], // Inactive coupon.
  ['FLAT50', 10, 0, 0, 10.5], // Discount exceeds subtotal.
  [' save10 ', 1000, 100, 100, 945], // Both normalize codes.
  ['UNKNOWN', 100, 0, 0, 105]
]) {
  test(`invoice matches billing: coupon ${JSON.stringify(code)} on ${price} gives billing discount ${billedDiscount} and invoice discount ${invoiceDiscount}`, () => {
    const items = [item({ price })];
    assert.equal(pricing.computeTotals(items, code).discount, billedDiscount);
    const actual = figures(items, code);
    assert.equal(actual.discount, invoiceDiscount);
    assert.equal(actual.total, invoiceTotal);
  });
}

test('invoice rounds each line tax consistently with billing', () => {
  const items = [item({ price: 0.03, gstRate: 18 }), item({ id: 2, price: 0.03, gstRate: 18 })];
  const billed = pricing.computeTotals(items, '');
  const actual = figures(items);
  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, billed.total], [0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual(actual.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([actual.tax, actual.cgst, actual.sgst, actual.total], [0.02, 0.01, 0.01, 0.08]);
});

test('saved order, khata charge and invoice agree without mutation', () => {
  const db = { nextOrderId: 1001, orders: [], customers: [{ id: 7, totalBilled: 0, totalSettled: 0, creditLimit: 5000 }] };
  const items = [item({ price: 1000 })];
  const totals = pricing.computeTotals(items, 'SAVE10');
  assert.equal(ledger.chargeOrderToKhata(db, 7, totals.total).ok, true);
  const order = orders.add(db, { date: '15/11/2026', items, coupon: 'SAVE10', customerId: 7, paymentMode: 'khata', ...totals });
  assert.equal(db.orders[0], order);
  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total, db.customers[0].totalBilled], [1000, 100, 45, 945, 945]);
  const before = JSON.stringify(db);
  assert.equal(invoice.computeInvoiceFigures(order).total, 945);
  const html = invoice.render(order);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
  assert.equal(JSON.stringify(db), before);
});

test('CURRENT BEHAVIOUR: stored subtotal, discount and tax do not affect invoice figures', () => {
  const items = [item()];
  assert.deepEqual(invoice.computeInvoiceFigures({ items, subtotal: 999, discount: 888, tax: 777, total: 1 }), figures(items));
});

test('CURRENT BEHAVIOUR: rendered Line Gross excludes GST and displays only combined GST total', () => {
  const html = invoice.render({ id: 1, items: [item({ gstRate: 5 })], total: 105 });
  assert.match(html, /<th class="r">Line Gross<\/th>/);
  assert.match(html, /<td class="r">₹5\.00<\/td><td class="r"><strong>₹100\.00<\/strong><\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹5\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
});

test('CURRENT BEHAVIOUR: reconciliation notice uses rounded difference with a one-paise threshold and signed amount', () => {
  const base = { id: 1, items: [item({ gstRate: 18 })] };
  assert.doesNotMatch(invoice.render({ ...base, total: 118.004 }), /Accountant Reconciliation Notice:/);
  assert.match(invoice.render({ ...base, total: 118.01 }), /by -₹0\.01/);
  assert.match(invoice.render({ ...base, total: 117.99 }), /by \+₹0\.01/);
});

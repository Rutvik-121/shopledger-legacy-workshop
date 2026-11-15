const test = require('node:test');
const assert = require('node:assert/strict');
const invoice = require('../lib/invoice');

test('invoice total and GST match the billed HSN order with SAVE10', () => {
  const order = {
    id: 1001, items: [{ id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }],
    coupon: 'SAVE10', subtotal: 1000, discount: 100, tax: 45, total: 945
  };
  const actual = invoice.computeInvoiceFigures(order);
  assert.deepEqual(
    { subtotal: actual.subtotal, discount: actual.discount, tax: actual.tax, cgst: actual.cgst, sgst: actual.sgst, total: actual.total },
    { subtotal: 1000, discount: 100, tax: 45, cgst: 22.5, sgst: 22.5, total: 945 }
  );
  assert.equal(actual.rows[0].gstPercent, 5);
  assert.equal(actual.rows[0].lineTax, 45);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice:/);
});

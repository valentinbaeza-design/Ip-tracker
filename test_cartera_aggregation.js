// Test de auditoría — pestaña Cartera (24/8/2026, punto 3).
// Bug encontrado: una suma de "valor actual" con datos parciales (algunos holdings sin
// precio en vivo) se mostraba igual que una suma completa, sin ningún aviso — mismo
// patrón que el hallazgo P1 original de Fase 1, pero en un rincón del panel que no se
// tocó entonces.
const assert = require("assert");
const { aggregateHoldingsCurrentValue } = require("./cartera_aggregation.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("OK   -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "->", e.message); }
}

// --- Caso 1 (el bug real): 2 de 3 holdings con precio -> debe marcarse isPartial ---
test("aggregateHoldingsCurrentValue: algunos holdings sin precio => isPartial true, suma solo de los conocidos", () => {
  const holdings = [{ current: 100 }, { current: 50 }, { current: null }];
  const r = aggregateHoldingsCurrentValue(holdings);
  assert.strictEqual(r.isPartial, true);
  assert.strictEqual(r.sum, 150);
  assert.strictEqual(r.known, 2);
  assert.strictEqual(r.total, 3);
});

// --- Caso 2: todos los holdings con precio -> NO debe marcarse parcial ---
test("aggregateHoldingsCurrentValue: todos con precio => isPartial false", () => {
  const holdings = [{ current: 100 }, { current: 50 }];
  const r = aggregateHoldingsCurrentValue(holdings);
  assert.strictEqual(r.isPartial, false);
  assert.strictEqual(r.sum, 150);
});

// --- Caso 3: ningún holding con precio (pero sí hay holdings) -> totalmente desconocido, no parcial ---
test("aggregateHoldingsCurrentValue: ninguno con precio => isFullyUnknown true, sum null (no un 0 falso)", () => {
  const holdings = [{ current: null }, { current: null }];
  const r = aggregateHoldingsCurrentValue(holdings);
  assert.strictEqual(r.isFullyUnknown, true);
  assert.strictEqual(r.isPartial, false);
  assert.strictEqual(r.sum, null, "sin ningún dato, el total debe ser null, nunca 0 (0 parecería un valor real)");
});

// --- Caso 4: clase sin holdings -> vacía legítimamente, sum=0 (no confundir con "desconocido") ---
test("aggregateHoldingsCurrentValue: sin holdings en absoluto => isEmpty true, sum 0 (0 real, no un fallo)", () => {
  const r = aggregateHoldingsCurrentValue([]);
  assert.strictEqual(r.isEmpty, true);
  assert.strictEqual(r.isPartial, false);
  assert.strictEqual(r.sum, 0);
});

// --- Caso 5: un solo holding con precio, de un solo holding total -> no es parcial (100% conocido) ---
test("aggregateHoldingsCurrentValue: un único holding con precio => no parcial (está completo)", () => {
  const r = aggregateHoldingsCurrentValue([{ current: 200 }]);
  assert.strictEqual(r.isPartial, false);
  assert.strictEqual(r.sum, 200);
});

console.log(`\n${pass} pasadas, ${fail} fallidas`);
process.exit(fail > 0 ? 1 : 0);

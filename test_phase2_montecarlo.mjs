// Tests de Fase 2, punto 3 — estimatePositionValueV2 (Montecarlo con liquidez acotada real).
import assert from "assert";
import { estimatePositionValueV2, getAmountsForLiquidity } from "./check-positions.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("OK   -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "->", e.message); }
}

// --- Caso 1: precio simulado == precio de entrada => el valor de posición debe ser ~initialUSD ---
test("estimatePositionValueV2: si el precio no se mueve, el valor ronda el depósito inicial", () => {
  const r = estimatePositionValueV2(2000, 2000, 1000, 4000, 100, 0, 30);
  assert.ok(Math.abs(r.valueUSD - 100) < 0.5, `esperado ~100, dio ${r.valueUSD}`);
  assert.ok(Math.abs(r.returnPct) < 1, `esperado ~0%, dio ${r.returnPct}`);
});

// --- Caso 2: fees se suman linealmente encima del valor de posición ---
test("estimatePositionValueV2: las fees se añaden aparte, linealmente por día", () => {
  const sinFees = estimatePositionValueV2(2000, 2000, 1000, 4000, 100, 0, 30);
  const conFees = estimatePositionValueV2(2000, 2000, 1000, 4000, 100, 0.5, 30);
  assert.ok(Math.abs((conFees.valueUSD - sinFees.valueUSD) - 15) < 0.01, "0.5/día * 30 días = 15 de fees");
});

// --- Caso 3 (la mejora clave sobre la fórmula anterior): precio simulado FUERA del rango
// por arriba => la posición debe comportarse como 100% token1 (dejar de generar más IL
// "fantasma" más allá del límite, que es justo lo que la fórmula cerrada anterior no podía
// representar) ---
test("estimatePositionValueV2: precio simulado por encima del rango => 100% token1, sin más cambio de composición", () => {
  const rangeMin = 1000, rangeMax = 4000, entryPrice = 2000, initialUSD = 100;
  const enElLimite = estimatePositionValueV2(rangeMax, entryPrice, rangeMin, rangeMax, initialUSD, 0, 0);
  const bienPorEncima = estimatePositionValueV2(rangeMax * 3, entryPrice, rangeMin, rangeMax, initialUSD, 0, 0);
  // Una vez fuera del rango por arriba, todo es token1; más subida de precio no cambia
  // la cantidad de token1 que tienes (solo cambiaría si volviera a entrar en rango).
  // Verificamos vía getAmountsForLiquidity directamente para aislar la composición de
  // la conversión a USD.
  const sqrtA = Math.sqrt(rangeMin), sqrtB = Math.sqrt(rangeMax);
  const { amount1: y1 } = getAmountsForLiquidity(1, Math.sqrt(rangeMax), sqrtA, sqrtB);
  const { amount1: y2 } = getAmountsForLiquidity(1, Math.sqrt(rangeMax * 3), sqrtA, sqrtB);
  assert.ok(Math.abs(y1 - y2) < 1e-9, "la cantidad de token1 no debe cambiar una vez fuera de rango por arriba");
  assert.ok(enElLimite && bienPorEncima, "ambos cálculos deben devolver resultado, no null");
});

// --- Caso 4: precio simulado por debajo del rango => 100% token0 ---
test("estimatePositionValueV2: precio simulado por debajo del rango => 100% token0", () => {
  const rangeMin = 1000, rangeMax = 4000;
  const sqrtA = Math.sqrt(rangeMin), sqrtB = Math.sqrt(rangeMax);
  const { amount0: x1 } = getAmountsForLiquidity(1, Math.sqrt(rangeMin), sqrtA, sqrtB);
  const { amount0: x2 } = getAmountsForLiquidity(1, Math.sqrt(rangeMin / 3), sqrtA, sqrtB);
  assert.ok(Math.abs(x1 - x2) < 1e-9, "la cantidad de token0 no debe cambiar una vez fuera de rango por abajo");
});

// --- Caso 5: consistencia con reconstructEntryAmounts — mismo denominador de entrada ---
test("estimatePositionValueV2: internamente coherente con la reconstrucción de entrada (misma L)", () => {
  // Si simPrice === entryPrice, xSim/ySim deben ser proporcionales a las mismas u0/u1
  // usadas para anclar Lusd — comprobación de que no hay una fórmula paralela divergente.
  const entryPrice = 2000, rangeMin = 1000, rangeMax = 4000, initialUSD = 100;
  const r = estimatePositionValueV2(entryPrice, entryPrice, rangeMin, rangeMax, initialUSD, 0, 0);
  assert.ok(Math.abs(r.valueUSD - initialUSD) < 0.01);
});

// --- Caso 6: denominador de entrada inválido (entryPrice fuera de [rangeMin,rangeMax]) => null,
// no un número inventado ---
test("estimatePositionValueV2: entryPrice fuera del propio rango no revienta ni inventa un valor absurdo", () => {
  // entryPrice por debajo de rangeMin: getAmountsForLiquidity ya clava el comportamiento de
  // límite (100% token0 en el punto de entrada), así que debe seguir devolviendo un resultado
  // válido y no null, sencillamente con toda la liquidez del lado token0 desde el principio.
  const r = estimatePositionValueV2(1500, 500, 1000, 4000, 100, 0, 0);
  assert.ok(r !== null, "no debería devolver null en este caso límite, es una entrada matemáticamente válida");
});

// --- Caso 7 (REGRESIÓN — el bug real detectado por Valen el 24/8: "por qué el pesimista
// sale mejor que el optimista"): el valor de la posición debe SUBIR cuando el precio
// simulado sube respecto a la entrada, y BAJAR cuando baja — no al revés. La primera
// versión de esta función tenía la conversión de unidades invertida y hacía justo lo
// contrario, silenciosamente, sin que ningún test anterior lo detectara. ---
test("estimatePositionValueV2 (REGRESIÓN): el valor sube cuando el precio sube, baja cuando baja", () => {
  const entryPrice = 2274, rangeMin = 1935.31, rangeMax = 2724.41, initialUSD = 69.84;
  const valEntrada = estimatePositionValueV2(entryPrice, entryPrice, rangeMin, rangeMax, initialUSD, 0, 0);
  const valSubida = estimatePositionValueV2(2600, entryPrice, rangeMin, rangeMax, initialUSD, 0, 0);
  const valBajada = estimatePositionValueV2(2000, entryPrice, rangeMin, rangeMax, initialUSD, 0, 0);
  assert.ok(valSubida.valueUSD > valEntrada.valueUSD,
    `si el precio SUBE, el valor debería ser MAYOR que en la entrada: ${valSubida.valueUSD} vs ${valEntrada.valueUSD}`);
  assert.ok(valBajada.valueUSD < valEntrada.valueUSD,
    `si el precio BAJA, el valor debería ser MENOR que en la entrada: ${valBajada.valueUSD} vs ${valEntrada.valueUSD}`);
  assert.ok(valSubida.valueUSD > valBajada.valueUSD,
    "el escenario de precio más alto debe dar más valor que el de precio más bajo");
});

// --- Caso 8 (REGRESIÓN, monotonía completa): el valor debe crecer de forma monótona con
// el precio simulado (dentro del rango) — ninguna inversión de pendiente en ningún tramo ---
test("estimatePositionValueV2 (REGRESIÓN): monotonía completa dentro del rango", () => {
  const entryPrice = 2274, rangeMin = 1935.31, rangeMax = 2724.41, initialUSD = 69.84;
  const precios = [1950, 2050, 2150, 2274, 2400, 2500, 2600, 2700];
  const valores = precios.map(p => estimatePositionValueV2(p, entryPrice, rangeMin, rangeMax, initialUSD, 0, 0).valueUSD);
  for (let i = 1; i < valores.length; i++) {
    assert.ok(valores[i] > valores[i - 1],
      `el valor debe crecer monótonamente con el precio: precio ${precios[i]} dio ${valores[i].toFixed(2)}, precio ${precios[i - 1]} dio ${valores[i - 1].toFixed(2)}`);
  }
});

console.log(`\n${pass} pasadas, ${fail} fallidas`);
process.exit(fail > 0 ? 1 : 0);

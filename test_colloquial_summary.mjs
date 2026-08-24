// Test de buildColloquialMcSummary — usa los números reales del mensaje de Telegram
// de hoy (posición WETH/ARB #5670128, 24/8/2026 21:07) como fixture de regresión.
import assert from "assert";
import { buildColloquialMcSummary } from "./check-positions.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("OK   -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "->", e.message); }
}

// --- Caso 1 (regresión, datos reales de hoy): el percentil 10 debe coincidir entre
// neutro y tendencia (ambos -7.1% según el mensaje real) => se detecta el efecto suelo ---
test("buildColloquialMcSummary: detecta el efecto suelo con los datos reales de hoy", () => {
  const mc = {
    neutro: {
      valorP10: { returnPct: -7.1 },
      valorP50: { returnPct: 6.6 },
      valorP90: { returnPct: 8.5 } // el mensaje real mostraba pesimista/mediana/optimista en otro orden de firma, aquí en % directo
    },
    tendencia: {
      valorP10: { returnPct: -7.1 }, // mismo peor caso que neutro -> debe detectar el suelo
      valorP90: { returnPct: -0.6 }
    }
  };
  const s = buildColloquialMcSummary(mc, 141.10);
  assert.ok(s.includes("En plata"), "debe empezar con la etiqueta de lectura coloquial");
  assert.ok(s.includes("no es casualidad"), "debe explicar el efecto suelo cuando los peores casos coinciden");
  assert.ok(s.includes("$131.07") || s.includes("$131.08"), `debe calcular el $ correcto para -7.1% sobre 141.10, dio: ${s}`);
});

// --- Caso 2: sin coincidencia entre escenarios => no debe mencionar el efecto suelo ---
test("buildColloquialMcSummary: sin coincidencia entre escenarios, no menciona el efecto suelo", () => {
  const mc = {
    neutro: { valorP10: { returnPct: -5 }, valorP50: { returnPct: 2 }, valorP90: { returnPct: 10 } },
    tendencia: { valorP10: { returnPct: -15 }, valorP90: { returnPct: 25 } } // bien distintos
  };
  const s = buildColloquialMcSummary(mc, 100);
  assert.ok(!s.includes("no es casualidad"), "no debería mencionar el efecto suelo si los percentiles no coinciden");
});

// --- Caso 3: ganancia en el peor caso también se redacta correctamente (no solo pérdidas) ---
test("buildColloquialMcSummary: si hasta el peor caso es positivo, dice 'ganar', no 'perder'", () => {
  const mc = {
    neutro: { valorP10: { returnPct: 3 }, valorP50: { returnPct: 8 }, valorP90: { returnPct: 15 } },
    tendencia: { valorP10: { returnPct: 5 }, valorP90: { returnPct: 20 } }
  };
  const s = buildColloquialMcSummary(mc, 100);
  assert.ok(s.includes("ganar"), `con peor caso positivo debería decir 'ganar', dio: ${s}`);
});

// --- Caso 4: consistencia numérica básica — el $ mostrado corresponde al % mostrado ---
test("buildColloquialMcSummary: el importe en $ es coherente con initialUSD y el %", () => {
  const mc = {
    neutro: { valorP10: { returnPct: -10 }, valorP50: { returnPct: 0 }, valorP90: { returnPct: 20 } },
    tendencia: { valorP10: { returnPct: -30 }, valorP90: { returnPct: 40 } }
  };
  const s = buildColloquialMcSummary(mc, 200);
  assert.ok(s.includes("$180.00"), `-10% sobre 200 = 180, dio: ${s}`);
  assert.ok(s.includes("$200.00"), `0% sobre 200 = 200, dio: ${s}`);
  assert.ok(s.includes("$240.00"), `+20% sobre 200 = 240, dio: ${s}`);
});

console.log(`\n${pass} pasadas, ${fail} fallidas`);
process.exit(fail > 0 ? 1 : 0);

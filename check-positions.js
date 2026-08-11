import { ethers } from "ethers";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const POSITION_MANAGER_BASE = "0x03a520b32C04BF3BEeF7BEb72E919cf822eD34f1";
const POSITION_MANAGER_ARB = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // misma dirección en Base y Arbitrum

const POSITIONS = [
  { label: "WETH/USDC · Base", tokenId: 5759912, rpc: "https://mainnet.base.org", pm: POSITION_MANAGER_BASE },
  { label: "WETH/ARB · Arbitrum", tokenId: 5642782, rpc: "https://arb1.arbitrum.io/rpc", pm: POSITION_MANAGER_ARB }
];

const PM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
];
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

function tickToPrice(tick, dec0, dec1) {
  // precio de token1 en unidades de token0, ajustado a decimales humanos
  const raw = Math.pow(1.0001, tick);
  return raw * Math.pow(10, dec0 - dec1);
}

async function checkPosition(cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpc);
  const pm = new ethers.Contract(cfg.pm, PM_ABI, provider);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

  const pos = await pm.positions(cfg.tokenId);
  const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const slot0 = await pool.slot0();

  const token0 = new ethers.Contract(pos.token0, ERC20_ABI, provider);
  const token1 = new ethers.Contract(pos.token1, ERC20_ABI, provider);
  const [sym0, dec0, sym1, dec1] = await Promise.all([
    token0.symbol(), token0.decimals(), token1.symbol(), token1.decimals()
  ]);

  const currentTick = Number(slot0.tick);
  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);
  const inRange = currentTick >= tickLower && currentTick < tickUpper;

  // precio actual y límites, expresados como token1 por token0
  const priceNow = tickToPrice(currentTick, Number(dec0), Number(dec1));
  const priceMin = tickToPrice(tickLower, Number(dec0), Number(dec1));
  const priceMax = tickToPrice(tickUpper, Number(dec0), Number(dec1));

  const rangeWidth = priceMax - priceMin;
  const distToLower = ((priceNow - priceMin) / rangeWidth * 100).toFixed(1);
  const distToUpper = ((priceMax - priceNow) / rangeWidth * 100).toFixed(1);

  return {
    label: cfg.label,
    inRange,
    pairLabel: `${sym1}/${sym0}`,
    priceNow: priceNow.toFixed(4),
    priceMin: priceMin.toFixed(4),
    priceMax: priceMax.toFixed(4),
    distToLower,
    distToUpper
  };
}

function buildMessage(results) {
  const lines = results.map(r => {
    const icon = r.inRange ? "🟢" : "🔴";
    const status = r.inRange ? "dentro de rango" : "FUERA DE RANGO";
    return `${icon} *${r.label}*\n${status} — ${r.pairLabel}: ${r.priceNow}\nRango: ${r.priceMin} – ${r.priceMax}\nMargen: ${r.distToLower}% desde el mínimo, ${r.distToUpper}% hasta el máximo`;
  });
  const now = new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" });
  return `📊 *Estado de posiciones LP* — ${now}\n\n` + lines.join("\n\n");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown" })
  });
  if (!res.ok) {
    console.error("Error enviando a Telegram:", await res.text());
  }
}

async function main() {
  const results = [];
  for (const cfg of POSITIONS) {
    try {
      const r = await checkPosition(cfg);
      results.push(r);
      console.log(r);
    } catch (e) {
      console.error(`Error en ${cfg.label}:`, e.message);
      results.push({ label: cfg.label, inRange: null, pairLabel: "?", priceNow: "?", priceMin: "?", priceMax: "?", distToLower: "?", distToUpper: "?" });
    }
  }
  await sendTelegram(buildMessage(results));
}

main();

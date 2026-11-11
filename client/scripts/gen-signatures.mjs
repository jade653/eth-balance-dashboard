/**
 * signatures.js 생성기: 사람이 읽는 서명 → keccak256 선택자/토픽.
 * 서명을 추가하려면 아래 목록을 고치고 다시 만든다 (keccak 구현만 잠깐 빌려 쓴다 — 저장소에는 의존성을 두지 않는다):
 *
 *   cd client && npm i --no-save js-sha3@0.9.3 && node scripts/gen-signatures.mjs
 */
import sha3 from 'js-sha3';
import fs from 'node:fs';
const { keccak256 } = sha3;

const FUNCS = [
  // ERC-20
  'transfer(address _to, uint256 _value)',
  'transferFrom(address _from, address _to, uint256 _value)',
  'approve(address _spender, uint256 _value)',
  'increaseAllowance(address spender, uint256 addedValue)',
  'decreaseAllowance(address spender, uint256 subtractedValue)',
  'mint(address to, uint256 amount)',
  'burn(uint256 amount)',
  'burnFrom(address account, uint256 amount)',
  // WETH
  'deposit()',
  'withdraw(uint256 wad)',
  // OpenZeppelin 관리
  'pause()',
  'unpause()',
  'grantRole(bytes32 role, address account)',
  'revokeRole(bytes32 role, address account)',
  'renounceRole(bytes32 role, address callerConfirmation)',
  'transferOwnership(address newOwner)',
  'renounceOwnership()',
  'upgradeTo(address newImplementation)',
  'upgradeToAndCall(address newImplementation, bytes data)',
  // 스테이블코인 운영 (USDC FiatToken 계열과 비슷한 이름들)
  'configureMinter(address minter, uint256 allowance)',
  'removeMinter(address minter)',
  'freeze(address account, bytes32 reason)',
  'freezeBatch(address[] accounts, bytes32 reason)',
  'unfreeze(address account)',
  'wipeFrozen(address account, bytes32 caseId)',
  'mintForRecovery(address to, uint256 amount, bytes32 caseId)',
  'setProtected(address account, bool on)',
  'setMinFreezeAge(uint64 secs)',
  'rescueERC20(address token, address to, uint256 amount)',
  // Safe 멀티시그 · 타임락
  'execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
  'schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)',
  'execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)',
  'cancel(bytes32 id)',
  // DEX · 기타
  'multicall(bytes[] data)',
  'multicall(uint256 deadline, bytes[] data)',
  'execute(bytes commands, bytes[] inputs, uint256 deadline)',
  'execute(bytes commands, bytes[] inputs)',
  'swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)',
];

// 튜플 인자라 디코딩은 하지 않고 이름만 보여줄 함수들 (선택자 계산용 정식 서명, 표시용 서명)
const NAME_ONLY = [
  ['exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', 'exactInputSingle(tuple params)'],
  ['handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)', 'handleOps(tuple[] ops, address beneficiary)'],
];

const EVENTS = [
  'Transfer(address indexed from, address indexed to, uint256 value)',
  'Approval(address indexed owner, address indexed spender, uint256 value)',
  'OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'Upgraded(address indexed implementation)',
  'AdminChanged(address previousAdmin, address newAdmin)',
  'Initialized(uint64 version)',
  'Initialized(uint8 version)',
  'RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
  'RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)',
  'Paused(address account)',
  'Unpaused(address account)',
  'Deposit(address indexed dst, uint256 wad)',
  'Withdrawal(address indexed src, uint256 wad)',
  'Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'Sync(uint112 reserve0, uint112 reserve1)',
  'Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'Mint(address indexed minter, address indexed to, uint256 amount)',
  'Burn(address indexed minter, uint256 amount)',
  'Frozen(address indexed account, address indexed operator, bytes32 indexed reason)',
  'Unfrozen(address indexed account, address indexed operator)',
  'FrozenFundsWiped(bytes32 indexed caseId, address indexed account, uint256 amount)',
  'RecoveryReissued(bytes32 indexed caseId, address indexed to, uint256 amount)',
  'MinterConfigured(address indexed minter, uint256 allowance)',
  'MinterRemoved(address indexed minter)',
  'ProtectedSet(address indexed account, bool on)',
  'MinFreezeAgeSet(uint64 secs)',
  'Rescued(address indexed token, address indexed to, uint256 amount)',
  'ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'ExecutionFailure(bytes32 txHash, uint256 payment)',
  'CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  'CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)',
  'Cancelled(bytes32 indexed id)',
  'BeforeExecution()',
  'UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
];

function parse(sig) {
  const m = /^(\w+)\((.*)\)$/.exec(sig);
  const params = m[2].trim() ? m[2].split(',').map((p) => {
    const parts = p.trim().split(/\s+/);
    const type = parts[0];
    const indexed = parts.includes('indexed');
    const name = parts.length > 1 ? parts[parts.length - 1] : '';
    return indexed ? [type, name, 1] : [type, name];
  }) : [];
  return { name: m[1], params, canonical: `${m[1]}(${params.map((p) => p[0]).join(',')})` };
}

const fn = {};
for (const s of FUNCS) {
  const p = parse(s);
  const sel = '0x' + keccak256(p.canonical).slice(0, 8);
  if (fn[sel]) throw new Error('selector clash ' + s);
  fn[sel] = [p.name, p.params];
}
for (const [canon, display] of NAME_ONLY) {
  const sel = '0x' + keccak256(canon).slice(0, 8);
  fn[sel] = [display.split('(')[0], null, display];
}
const ev = {};
for (const s of EVENTS) {
  const p = parse(s);
  const topic = '0x' + keccak256(p.canonical);
  if (ev[topic]) throw new Error('topic clash ' + s);
  ev[topic] = [p.name, p.params];
}

// 알려진 값으로 생성기 자체를 검증
const must = {
  '0xa9059cbb': 'transfer', '0x095ea7b3': 'approve', '0x23b872dd': 'transferFrom', '0x765e827f': 'handleOps',
};
for (const [k, v] of Object.entries(must)) if (fn[k]?.[0] !== v) throw new Error('bad ' + k);
if (ev['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'][0] !== 'Transfer') throw new Error('bad Transfer');
if (ev['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'][0] !== 'Approval') throw new Error('bad Approval');

const json = (o) => JSON.stringify(o, null, 0).replace(/\],"/g, '],\n  "').replace(/^\{/, '{\n  ').replace(/\}$/, ',\n}');
const out = `/**
 * 함수 선택자 · 이벤트 토픽 사전. (자동 생성 — 손으로 고치지 말고 서명 목록을 고쳐 다시 만든다)
 *
 * 선택자 = keccak256("transfer(address,uint256)") 의 앞 4바이트, 이벤트 토픽 = 전체 32바이트.
 * 해시라서 거꾸로 이름을 구할 수 없다 — Etherscan 도 검증된 소스(ABI)나 이런 사전으로 이름을 붙인다.
 *
 *   FUNCTIONS[선택자] = [이름, [[타입, 인자이름], …] | null(튜플 등 디코딩 안 함), 표시용 서명?]
 *   EVENTS[토픽0]    = [이름, [[타입, 인자이름, 1(indexed)?], …]]
 */
export const FUNCTIONS = ${json(fn)};

export const EVENTS = ${json(ev)};
`;
const target = process.argv[2] ?? new URL('../public/js/signatures.js', import.meta.url);
fs.writeFileSync(target, out);
console.log('functions', Object.keys(fn).length, 'events', Object.keys(ev).length);

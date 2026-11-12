const MiB = 1024 * 1024;
const profiles = {
  1536: {
    workingOld: { gateway: 48, web: 64, background: 64, command: 64 },
    shares: { gateway: [16, 128], web: [32, 32], background: [32, 32], command: [24, 32] },
    reserves: { nativeMiB: 192, externalMiB: 384, ipcMiB: 0, safetyMiB: 32 },
  },
  2560: {
    workingOld: { gateway: 80, web: 112, background: 112, command: 96 },
    shares: { gateway: [32, 128], web: [64, 32], background: [64, 32], command: [48, 32] },
    reserves: { nativeMiB: 384, externalMiB: 512, ipcMiB: 128, safetyMiB: 80 },
  },
  4096: {
    workingOld: { gateway: 80, web: 112, background: 112, command: 96 },
    shares: { gateway: [48, 128], web: [64, 32], background: [64, 32], command: [48, 32] },
    reserves: {
      nativeMiB: 384,
      externalMiB: 576,
      ipcMiB: 128,
      safetyMiB: 80,
      extraWorkMiB: 1472,
    },
  },
  8192: {
    workingOld: { gateway: 256, web: 112, background: 112, command: 96 },
    shares: { gateway: [1152, 128], web: [64, 32], background: [64, 32], command: [48, 32] },
    reserves: {
      nativeMiB: 384,
      externalMiB: 1680,
      ipcMiB: 128,
      safetyMiB: 80,
      extraWorkMiB: 1472,
    },
  },
};
// A valid large card/import must retain the former operation's V8 ceiling.
// These ceilings are not simultaneous reservations or an aggregate RSS limit.
const compatibleOld = { gateway: 256, web: 768, background: 256, command: 768 };
function failure(code = 'NATIVE_MEMORY_BUDGET_INVALID') {
  return Object.assign(Error('Native memory budget is invalid.'), { code });
}
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

// A process-level V8 flag also overrides nested Worker resourceLimits. Charge
// the same effective old/young ceiling for every isolate in that process.
// Working targets divide the operating budget; compatible ceilings may exceed
// those targets during one large operation. Cache and admission byte limits are
// enforced separately. Neither targets nor estimates guarantee a maximum RSS.
function createNativeMemoryBudget({
  budgetMiB,
  commandCount,
  postgres,
  releaseGate = false,
  queryConcurrency = 2,
} = {}) {
  if (
    !Number.isSafeInteger(budgetMiB) ||
    !Object.hasOwn(profiles, budgetMiB) ||
    !Number.isInteger(commandCount) ||
    commandCount < 0 ||
    commandCount > 4 ||
    (![4096, 8192].includes(budgetMiB) && commandCount > 2) ||
    ([4096, 8192].includes(budgetMiB) && (commandCount < 2 || postgres !== true)) ||
    typeof postgres !== 'boolean' ||
    typeof releaseGate !== 'boolean' ||
    !Number.isInteger(queryConcurrency) ||
    queryConcurrency < 2 ||
    queryConcurrency > 6 ||
    (![4096, 8192].includes(budgetMiB) && queryConcurrency > 4) ||
    (!postgres && queryConcurrency !== 2)
  )
    throw failure();
  const profile = profiles[budgetMiB],
    semiSpaceMiB = 2,
    stackMiB = 2,
    leaseWorkers = postgres && !releaseGate ? 1 : 0;
  const processes = [];
  function add(identity, role, isolateCount) {
    // Preserve the gateway's aggregate operating allocation as its isolate
    // count changes. These are working targets, never V8 limits or admission.
    const perIsolateOverheadMiB = 3 * semiSpaceMiB + stackMiB;
    const gatewayOperatingMiB =
      (1 + 2 * (postgres ? 2 : 1)) * (profile.workingOld.gateway + perIsolateOverheadMiB);
    const oldGenerationMiB = compatibleOld[role],
      workingOldTargetMiB =
        role === 'gateway' && queryConcurrency !== 2
          ? Math.floor(gatewayOperatingMiB / isolateCount) - perIsolateOverheadMiB
          : profile.workingOld[role],
      commandOperatingMiB =
        2 * (postgres ? 2 : 1) * (profile.workingOld.command + perIsolateOverheadMiB),
      selectedWorkingOldTargetMiB =
        [4096, 8192].includes(budgetMiB) && role === 'command'
          ? Math.floor(commandOperatingMiB / (commandCount * isolateCount)) - perIsolateOverheadMiB
          : workingOldTargetMiB,
      [cacheMiB, bufferMiB] = profile.shares[role],
      shareOwners = [4096, 8192].includes(budgetMiB) && role === 'command' ? commandCount : 2,
      cacheBytes =
        budgetMiB === 8192 && role === 'gateway'
          ? queryConcurrency * 192 * MiB
          : Math.floor((cacheMiB * MiB * 2) / shareOwners),
      bufferReserveBytes = Math.floor((bufferMiB * MiB * 2) / shareOwners);
    processes.push({
      version: 1,
      identity,
      role,
      isolateCount,
      oldGenerationMiB,
      workingOldTargetMiB: selectedWorkingOldTargetMiB,
      semiSpaceMiB,
      stackMiB,
      heapCeilingMiB: oldGenerationMiB + 3 * semiSpaceMiB,
      execArgv: [
        '--max-old-space-size=' + oldGenerationMiB,
        '--max-semi-space-size=' + semiSpaceMiB,
        '--stack-size=' + stackMiB * 1024,
      ],
      workerResourceLimits: {
        maxOldGenerationSizeMb: oldGenerationMiB,
        maxYoungGenerationSizeMb: 2 * semiSpaceMiB,
        stackSizeMb: stackMiB,
      },
      cacheBytes,
      bufferReserveBytes,
      externalReserveBytes: cacheBytes + bufferReserveBytes,
      queryCacheBytes: role === 'gateway' ? Math.floor(cacheBytes / queryConcurrency) : 0,
    });
  }
  add('gateway', 'gateway', 1 + queryConcurrency * (postgres ? 2 : 1));
  add('web', 'web', postgres ? 2 : 1);
  add('background', 'background', (postgres ? 2 : 1) + leaseWorkers);
  for (let index = 0; index < commandCount; index++)
    add(index ? 'command-' + index : 'command', 'command', postgres ? 2 : 1);
  const sum = (work) => processes.reduce((total, process) => total + work(process), 0);
  const oldGenerationMiB = sum((p) => p.oldGenerationMiB * p.isolateCount),
    workingOldTargetMiB = sum((p) => p.workingOldTargetMiB * p.isolateCount),
    youngGenerationMiB = sum((p) => 3 * p.semiSpaceMiB * p.isolateCount),
    stacksMiB = sum((p) => p.stackMiB * p.isolateCount),
    reservedMiB = Object.values(profile.reserves).reduce((a, b) => a + b, 0),
    workingAllocatedMiB = workingOldTargetMiB + youngGenerationMiB + stacksMiB + reservedMiB,
    cacheBytes = sum((p) => p.cacheBytes),
    bufferReserveBytes = sum((p) => p.bufferReserveBytes);
  if (
    workingAllocatedMiB > budgetMiB ||
    cacheBytes + bufferReserveBytes > profile.reserves.externalMiB * MiB
  )
    throw failure();
  return frozen({
    version: 1,
    managed: true,
    model: 'working-targets-and-compatible-ceilings-v2',
    heapCeilingsOverSubscribed: oldGenerationMiB + youngGenerationMiB > budgetMiB,
    compatibilityCeilingsAreReservations: false,
    hardRssLimitSource: 'external-container-or-host',
    noOomGuarantee: true,
    budgetMiB,
    postgres,
    releaseGate,
    commandCount,
    queryConcurrency,
    topology: {
      processCount: processes.length,
      queryWorkers: queryConcurrency,
      sqlWorkers: postgres ? 2 + queryConcurrency + commandCount : 0,
      leaseWorkers,
      isolateCount: sum((p) => p.isolateCount),
    },
    processes,
    reserves: { ...profile.reserves },
    workAdmission: {
      version: 1,
      // Ordinary commands keep their 512 MiB estimate. The explicit 4096/8192 MiB
      // profile reserves its larger work window above; imports remain exclusive.
      maxBytes:
        ([4096, 8192].includes(budgetMiB)
          ? 1536 + profile.reserves.extraWorkMiB
          : budgetMiB === 1536
            ? commandCount === 2
              ? 1024
              : 896
            : 1536) * MiB,
      queryBytes: 384 * MiB,
      // Only the bounded PG operation reader may start with this estimate.
      // Before fetching an oversized result it yields the probe and obtains
      // the unchanged full-query reservation; legacy readers keep 384 MiB.
      ...(postgres ? { queryProbeBytes: 96 * MiB } : {}),
      commandBytes: 512 * MiB,
      maxPending: 32,
      waitMs: 5000,
      estimatedWorkingSet: true,
      commandOwners: commandCount,
      additionalRssReservation: false,
      rssHardCapClaim: false,
    },
    totals: {
      oldGenerationMiB,
      compatibilityHeapCeilingsMiB: oldGenerationMiB + youngGenerationMiB,
      workingOldTargetMiB,
      youngGenerationMiB,
      stacksMiB,
      reservedMiB,
      workingAllocatedMiB,
      workingUnallocatedMiB: budgetMiB - workingAllocatedMiB,
      cacheBytes,
      bufferReserveBytes,
    },
    bufferReserveNotHardLimit: true,
    rssHardCapClaim: false,
  });
}
function configuredNativeMemoryBudget(config, commandCount) {
  const version = config.nativeMemoryBudgetVersion ?? 0,
    budgetMiB = config.nativeMemoryBudgetMiB ?? 0,
    queryConcurrency = config.nativeQueryWorkers ?? 2;
  if (
    (queryConcurrency !== 2 || commandCount > 2 || [4096, 8192].includes(budgetMiB)) &&
    (version !== 1 || config.storageBackend !== 'postgres' || config.postgresRevisionProfile !== 3)
  )
    throw failure();
  if ((queryConcurrency > 4 || commandCount > 2) && ![4096, 8192].includes(budgetMiB))
    throw failure();
  if ([4096, 8192].includes(budgetMiB) && config.nativeCommandIsolation === false) throw failure();
  if (version === 0 && budgetMiB === 0) return null;
  if (version !== 1) throw failure();
  return createNativeMemoryBudget({
    budgetMiB,
    commandCount,
    postgres: config.storageBackend === 'postgres',
    releaseGate: config.releaseGate ?? false,
    queryConcurrency,
  });
}
function nativeMemoryProcess(plan, identity) {
  const process = plan?.processes?.find((entry) => entry.identity === identity);
  if (plan?.version !== 1 || !process) throw failure();
  return process;
}

// Preserve unrelated preload/debug options byte-for-byte. Conflicting V8 flags
// are refused before fork rather than silently stripping operator configuration.
function assertNativeMemoryEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment))
    throw failure('NATIVE_MEMORY_FLAGS_CONFLICT');
  const source = environment.NODE_OPTIONS;
  if (source === undefined || source === '') return;
  if (typeof source !== 'string' || source.length > 32768)
    throw failure('NATIVE_MEMORY_FLAGS_CONFLICT');
  const tokens = [];
  let token = '',
    quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') quoted = !quoted;
    else if (char === '\\' && source[index + 1] === '"') token += source[++index];
    else if (!quoted && /\s/.test(char)) {
      if (token) tokens.push(token);
      token = '';
    } else token += char;
  }
  if (quoted) throw failure('NATIVE_MEMORY_FLAGS_CONFLICT');
  if (token) tokens.push(token);
  for (const token of tokens) {
    const flag = token.split('=', 1)[0].replaceAll('_', '-');
    if (
      /^--(?:max-(?:old-space-size(?:-percentage)?|semi-space-size|heap-size)|initial-old-space-size|huge-max-old-generation-size|stack-size)$/.test(
        flag,
      )
    )
      throw failure('NATIVE_MEMORY_FLAGS_CONFLICT');
  }
}
module.exports = {
  createNativeMemoryBudget,
  configuredNativeMemoryBudget,
  nativeMemoryProcess,
  assertNativeMemoryEnvironment,
};

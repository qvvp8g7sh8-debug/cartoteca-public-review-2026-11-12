// Codex functions.exec adapter. No Node globals, credentials or signed URLs in output.
// Load this trusted source and call followRelease(tools, options, emit).
async function followRelease(tools, options, emit) {
  const id = options.id;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '')) throw Error('Invalid flow id');
  if (!['start', 'continue', 'status'].includes(options.mode || 'continue'))
    throw Error('Invalid flow mode');
  const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  const parse = (result) => {
    if (result.isError || typeof result.structuredContent?.content !== 'string')
      throw Error('GitHub connector unavailable');
    return JSON.parse(result.structuredContent.content);
  };
  const api = async (url) => parse(await tools.mcp__codex_apps__github_fetch({ url }));
  async function local(command, input) {
    const argumentsText =
      command === 'start'
        ? options.publish === true
          ? ' --publish --deploy-config ' + quote(options.deployConfig)
          : ''
        : '';
    const prefix = input === undefined ? '' : "@'\n" + JSON.stringify(input) + "\n'@ | ";
    if (command === 'start' && options.publish === true && !options.deployConfig)
      throw Error('Deployment configuration required');
    const cmd =
      prefix + 'node scripts/release-follow.cjs ' + command + ' ' + quote(id) + argumentsText;
    let result = await tools.exec_command({
      cmd,
      workdir: options.workspace,
      sandbox_permissions: 'require_escalated',
      yield_time_ms: 1000,
      max_output_tokens: 8000,
    });
    let pending = '',
      state,
      heartbeat = Date.now();
    function consume(output) {
      pending += output;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row.event === 'result') state = row;
        else if (['phase', 'download', 'error'].includes(row.event)) emit(row);
        else if (row.status && row.stage !== undefined)
          emit({ event: 'server', status: row.status, stage: row.stage });
      }
    }
    consume(result.output);
    while (result.session_id) {
      result = await tools.write_stdin({
        session_id: result.session_id,
        chars: '',
        yield_time_ms: 1000,
        max_output_tokens: 8000,
      });
      consume(result.output);
      if (Date.now() - heartbeat >= 45000) {
        emit({ event: 'working', stage: command });
        heartbeat = Date.now();
      }
    }
    if (pending.trim()) consume('\n');
    if (!state) throw Error('Local flow did not return a state; inspect its private journal');
    return state;
  }
  const selectRun = (run) => ({
    id: run.id,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    path: run.path,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    repository: { full_name: run.repository?.full_name },
  });
  let state = await local(options.mode === 'start' ? 'start' : 'status');
  if (options.mode === 'status') return state;
  if (['publishing', 'verification'].includes(state.phase)) state = await local('advance', {});
  let lastProgress = 0,
    failures = 0;
  while (state.action && !state.interrupted) {
    const action = state.action;
    try {
      let input;
      if (action.kind === 'ci') {
        let run, jobs;
        if (action.jobsUrl) {
          const replies = await Promise.allSettled([api(action.url), api(action.jobsUrl)]);
          for (const reply of replies)
            if (reply.status !== 'fulfilled') throw Error('CI metadata unavailable');
          [run, jobs] = replies.map((reply) => reply.value);
        } else run = await api(action.url);
        input = {
          kind: 'ci',
          ...(run.workflow_runs
            ? { runs: run.workflow_runs.map(selectRun) }
            : { run: selectRun(run) }),
          ...(jobs
            ? {
                jobs: jobs.jobs.map((job) => ({
                  id: job.id,
                  name: job.name,
                  conclusion: job.conclusion,
                  steps: job.steps?.map((step) => ({
                    name: step.name,
                    conclusion: step.conclusion,
                  })),
                })),
                totalJobs: jobs.total_count,
              }
            : {}),
        };
        if (Date.now() - lastProgress >= 45000) {
          emit({
            event: 'ci',
            complete: jobs?.jobs.filter((j) => j.status === 'completed').length,
            total: jobs?.total_count,
            status: run.status || 'discovering',
          });
          lastProgress = Date.now();
        }
      } else if (action.kind === 'artifacts') {
        const artifacts = await api(action.url);
        input = {
          kind: 'artifacts',
          total: artifacts.total_count,
          artifacts: artifacts.artifacts.map((a) => ({
            id: a.id,
            name: a.name,
            expired: a.expired,
            digest: a.digest,
            size_in_bytes: a.size_in_bytes,
            workflow_run: { id: a.workflow_run?.id, head_sha: a.workflow_run?.head_sha },
          })),
        };
      } else if (action.kind === 'reference') {
        const result = await tools.mcp__codex_apps__github_download_workflow_artifact({
          repo_full_name: action.repository,
          artifact_id: action.artifactId,
          file_name: action.name + '.zip',
        });
        const reference = result.structuredContent?.file_uri?.download_url;
        if (result.isError || !reference) throw Error('GitHub artifact reference unavailable');
        input = { kind: 'reference', artifactId: action.artifactId, url: reference };
      } else throw Error('Unsupported flow action');
      const previousRun = action.jobsUrl;
      state = await local('advance', input);
      failures = 0;
      if (state.interrupted && state.action?.kind === 'reference') state.interrupted = false;
      if (state.action?.kind === 'ci' && (previousRun || !state.action.jobsUrl))
        await new Promise((resolve) => setTimeout(resolve, state.action.pollMs));
      if (
        state.action?.kind === 'artifacts' &&
        state.phase === 'diagnostics' &&
        action.kind === 'artifacts'
      )
        await new Promise((resolve) => setTimeout(resolve, 30000));
    } catch {
      if (++failures > 2) {
        emit({
          event: 'interrupted',
          message: 'Connector or local flow unavailable; continue this same flow after inspection',
        });
        return { id, phase: state.phase, interrupted: true };
      }
      emit({
        event: 'retry',
        attempt: failures,
        message: 'Retrying metadata retrieval; no tests or publication are restarted',
      });
      await new Promise((resolve) => setTimeout(resolve, failures * 5000));
    }
  }
  // reference can be retried once with a new URI; deployment interruptions always return for reconciliation.
  if (state.interrupted && state.action?.kind === 'reference') {
    emit({
      event: 'interrupted',
      message: 'Obtain a fresh file reference by continuing this same flow',
    });
  }
  return state;
}

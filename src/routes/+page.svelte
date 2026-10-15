<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { activeExecution, emptyMission, type Activity, type Attention, type MissionState } from '$lib/mission';
  import '../app.css';
  import { activityContext } from '$lib/activity-context';

  let mission = $state<MissionState>(emptyMission());
  let streamOnline = $state(false);
  let view = $state<'home' | 'setup' | 'chat'>('home');
  let receivedState = $state(false);
  let chatSearch = $state('');
  let chatProject = $state('');
  const savedChats = $derived((mission.savedMissions || []).filter(saved => saved.id !== mission.id).sort((a, b) => b.updated - a.updated));
  const projects = $derived([...new Set((mission.savedMissions || []).map(saved => saved.project))]);
  const filteredChats = $derived(savedChats.filter(saved =>
    (!chatProject || saved.project === chatProject) &&
    `${saved.title} ${saved.project}`.toLowerCase().includes(chatSearch.trim().toLowerCase())
  ));
  const savedStatus = (execution: string) => ['working', 'starting', 'stopping', 'unknown'].includes(execution)
    ? 'Needs reconciliation' : ({ completed: 'Ready for follow-up', failed: 'Response failed', interrupted: 'Stopped', idle: 'Ready' }[execution] || execution);
  const updatedDate = (value: number) => new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  async function beginNew(path = '') {
    if (running || mission.execution === 'unknown') { error = 'Stop the current work or reconnect before opening another mission.'; return; }
    if (mission.id) {
      await perform({ action: 'end' });
      if (error) return;
    }
    project = path; draft = ''; view = 'setup';
    if (!path) { await tick(); chooseFolder(); }
  }
  async function openMission(id: string) {
    await perform({ action: 'open', id });
    if (mission.id === id) { draft = ''; follow = true; view = 'chat'; }
  }
  let project = $state('');
  let folderPicker = $state<HTMLDialogElement>();
  let folderPath = $state('');
  let folderParent = $state('');
  let folderInput = $state('');
  let folders = $state<{ name: string; path: string }[]>([]);
  let folderLoading = $state(false);
  let folderError = $state('');
  let permissionsOpen = $state(false);
  function goHome() { view = 'home'; }
  let sandbox = $state('workspace-write');
  let draft = $state('');
  let pending = $state(false);
  let stopping = $state(false);
  let error = $state('');
  let showAllActivity = $state(false);
  let answers = $state<Record<string, string>>({});
  let chatElement = $state<HTMLDivElement>();
  function openInspector(node: HTMLDialogElement) { node.showModal(); }
  let follow = $state(true);
  const currentGoal = $derived(mission.goalHistory?.at(-1));
  let editingGoal = $state(false);
  let goalTitle = $state('');
  let goalDescription = $state('');
  let goalVersion = $state(0);
  function editGoal() {
    goalTitle = currentGoal?.title || mission.title;
    goalDescription = currentGoal?.description || mission.objective;
    goalVersion = currentGoal?.version || 0;
    editingGoal = true;
  }
  async function sendGoal(event: SubmitEvent) {
    event.preventDefault();
    await perform({ action: 'correctGoal', title: goalTitle, description: goalDescription, baseVersion: goalVersion });
    if (!error) editingGoal = false;
  }
  let selectedDecisionId = $state<string | null>(null);
  const selectedDecision = $derived(mission.decisions?.find(d => d.id === selectedDecisionId && d.disposition !== 'dismissed'));
  let highlightedMessage = $state<string | null>(null);
  async function showDecision(messageId: string) {
    follow = false;
    highlightedMessage = messageId;
    await tick();
    const target = document.getElementById(`message-${messageId}`);
    if (!target) { error = 'The source message is not available in this conversation.'; return; }
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.focus({ preventScroll: true });
    follow = false;
  }
  const messageGroups = $derived.by(() => {
    const groups: { id: string; role: 'user' | 'agent'; messages: MissionState['messages'] }[] = [];
    for (const message of mission.messages) {
      const previous = groups.at(-1);
      if (previous?.role === message.role) previous.messages.push(message);
      else groups.push({ id: message.id, role: message.role, messages: [message] });
    }
    return groups;
  });
  const connected = $derived(streamOnline && mission.connection === 'connected');
  const running = $derived(activeExecution(mission));
  const activeItems = $derived(mission.activities.filter(a => a.status === 'inProgress' && !mission.attention.some(r => r.params.itemId === a.id)));
  const recentActivities = $derived([...mission.activities].reverse().filter(a => showAllActivity || !['reasoning', 'plan'].includes(a.type)).slice(0, showAllActivity ? 250 : 3));
  const latestOperation = $derived(activeItems.at(-1));
  const pendingDecisions = $derived((mission.decisions || []).filter(d => d.disposition === 'proposed'));
  const attention = $derived(mission.attention.filter(a => !a.responding));
  const status = $derived(!streamOnline && mission.id ? 'Live connection lost' : mission.connection === 'lost' ? (mission.execution === 'unknown' ? 'Work status unknown' : 'App Server disconnected') : mission.connection === 'connecting' ? 'Connecting to Codex' : mission.execution === 'stopping' ? 'Stopping…' : attention.length ? 'Needs your input' : ({ idle: 'Ready', starting: 'Starting…', working: 'Working', completed: 'Ready for follow-up', interrupted: 'Stopped', failed: 'Response failed', unknown: 'Work status unknown' }[mission.execution] || 'Ready'));
  const awaiting = (activity: Activity) => mission.attention.find(r => r.params.itemId === activity.id);
  const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const label = (value: string) => ({ inProgress: 'Running', completed: 'Completed', failed: 'Failed', declined: 'Declined', interrupted: 'Stopped', unknown: 'Unknown', reported: 'Agent-reported' }[value] || value);
  const shortCommand = (a: Activity) => a.details.commandActions?.map((c: { command: string }) => c.command).join('; ') || a.title;
  const activityName = (a: Activity) => a.type === 'commandExecution' ? 'Shell command' : a.type === 'fileChange' ? 'File change' : a.type === 'dynamicToolCall' ? (a.details.tool === 'player_two_propose_decision' ? 'Decision proposal' : 'Next-step proposal') : a.type === 'mcpToolCall' ? `Tool: ${a.details.tool}` : a.title;
  const operationDescription = (a: Activity) => activityContext(a).title;
  const approvalTitle = (a: Attention) => a.params.networkApprovalContext ? 'Network access requested' : a.method === 'item/commandExecution/requestApproval' ? 'Command approval' : a.method === 'item/fileChange/requestApproval' ? 'File change approval' : a.method === 'item/permissions/requestApproval' ? 'Permission request' : a.method === 'item/tool/requestUserInput' ? 'Codex has a question' : 'Tool request';
  function decisions(a: Attention): string[] {
    if (a.method === 'item/permissions/requestApproval') return ['accept', 'decline'];
    if (a.method === 'mcpServer/elicitation/request') return ['decline', 'cancel'];
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(a.method)) return [];
    return (a.params.availableDecisions || ['accept', 'decline', 'cancel']).filter((d: unknown) => typeof d === 'string' && ['accept', 'decline', 'cancel'].includes(d));
  }
  // Apply both HTTP and streamed snapshots through the same chat boundary.
  function acceptState(next: MissionState) {
    if (next.id !== mission.id) {
      draft = ''; answers = {}; editingGoal = false;
      goalTitle = ''; goalDescription = ''; goalVersion = 0;
      selectedDecisionId = null; highlightedMessage = null;
      showAllActivity = false; permissionsOpen = false;
      folderPicker?.close(); project = ''; follow = true;
      if (!next.id && view === 'chat') view = 'home';
    }
    mission = next;
  }
  async function action(data: Record<string, unknown>) {
    error = '';
    const sourceId = mission.id;
    const response = await fetch('/api/mission', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, missionId: mission.id }) });
    const body = await response.json();
    if (body.state) {
      // A reply to an earlier chat must not replace a newer streamed selection.
      if (mission.id !== sourceId && mission.id !== body.state.id) throw new Error('The selected chat changed. Your action was not applied to this chat.');
      acceptState(body.state);
    }
    if (!response.ok) throw new Error(body.error || 'Request failed');
  }
  async function perform(data: Record<string, unknown>) {
    pending = true;
    try { await action(data); } catch (e) { error = String(e); } finally { pending = false; }
  }
  async function browseFolders(path = '') {
    folderLoading = true;
    folderError = '';
    try {
      const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      folderPath = body.path; folderInput = body.path;
      folderParent = body.parent; folders = body.folders;
    } catch (e) { folderError = e instanceof Error ? e.message : 'Could not open folder.'; }
    finally { folderLoading = false; }
  }
  function chooseFolder() {
    folderPicker?.showModal();
    void browseFolders(project);
  }
  const sendDisabled = $derived(!draft.trim() || pending || (mission.id ? !connected : !streamOnline || !project) || ['starting', 'stopping', 'unknown'].includes(mission.execution));
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (sendDisabled) return;
    const text = draft;
    pending = true;
    try {
      error = '';
      await action(mission.id ? { action: 'message', text, steer: running } : { action: 'start', project, objective: text, sandbox, exploratory: true });
      draft = ''; follow = true; view = 'chat';
    }
    catch (e) { error = String(e); } finally { pending = false; }
  }
  async function stop() {
    stopping = true;
    try { await action({ action: 'stop' }); } catch (e) { error = String(e); } finally { stopping = false; }
  }
  onMount(() => {
    const events = new EventSource('/api/events');
    events.onmessage = async event => {
      acceptState(JSON.parse(event.data)); streamOnline = true; receivedState = true;
      await tick();
      if (follow && chatElement) chatElement.scrollTop = chatElement.scrollHeight;
    };
    events.onopen = () => { streamOnline = true; };
    events.onerror = () => { streamOnline = false; };
    return () => {
      events.close();
    };
  });
</script>

<svelte:head><title>Player Two</title><meta name="description" content="A local workspace for staying oriented while Codex works." /></svelte:head>

{#snippet approvalRequests(requests: Attention[])}
        {#if requests.length}
          <div class="attention-stack" aria-label="Requests needing attention">
            {#each requests as request (request.id)}
              <section class="approval">
                <div class="eyebrow">{request.method === 'item/tool/requestUserInput' ? 'QUESTION' : 'PERMISSION REQUEST'} <span>{request.responding ? 'RESPONSE SENT · AWAITING CONFIRMATION' : 'ACTION REQUIRED'}</span></div>
                <h3>{approvalTitle(request)}</h3>
                {#if request.params.reason}<p>{request.params.reason}</p>{/if}
                {#if request.params.command}<pre>{request.params.command}</pre>{/if}
                {#if request.params.cwd}<p class="request-cwd">In {request.params.cwd}</p>{/if}
                {#if request.method === 'item/tool/requestUserInput'}
                  {#each request.params.questions || [] as question (question.id)}
                    <label for={`q-${question.id}`}>{question.question}</label>
                    {#if question.options?.length}<div class="question-options">{#each question.options as option (option.label)}<button onclick={() => answers[question.id] = option.label} title={option.description}>{option.label}</button>{/each}</div>{/if}
                    <input id={`q-${question.id}`} bind:value={answers[question.id]} placeholder="Your answer" />
                  {/each}
                  <button class="primary" disabled={request.responding || !connected || pending} onclick={() => perform({ action: 'answer', id: request.id, choice: 'answer', answers })}>Send answer</button>
                {:else}
                  {#if request.method === 'item/fileChange/requestApproval'}
                    {@const change = mission.activities.find(a => a.id === request.params.itemId)}
                    {#if change}<details><summary>Proposed changes</summary><pre>{JSON.stringify(change.details.changes || change.details, null, 2)}</pre></details>{/if}
                  {/if}
                  {#if request.params.permissions || request.params.networkApprovalContext || request.params.additionalPermissions}<pre>{JSON.stringify(request.params.permissions || request.params.networkApprovalContext || request.params.additionalPermissions, null, 2)}</pre>{/if}
                  <div class="approval-actions">{#each decisions(request) as decision (decision)}<button class:primary={decision === 'accept'} disabled={request.responding || !connected || pending} onclick={() => perform({ action: 'answer', id: request.id, choice: decision })}>{decision === 'accept' ? (request.method === 'item/permissions/requestApproval' ? 'Allow until this response ends' : 'Allow once') : decision === 'cancel' ? 'Cancel request' : 'Decline'}</button>{/each}</div>
                  {#if !decisions(request).length}<p>This request type is not supported yet. Stop Codex to cancel it.</p>{/if}
                {/if}
              </section>
            {/each}
          </div>
        {/if}
{/snippet}

<div class="app-shell">
  {#if view === 'home'}
    <main class="home-screen">
      <header class="home-heading">
        <div><span class="eyebrow">PLAYER TWO</span><h1>Chats</h1><p>Pick up a conversation or start something new.</p></div>
        <button class="primary" disabled={!receivedState || !streamOnline || pending || running || mission.execution === 'unknown'} onclick={() => beginNew()}>＋ New chat</button>
      </header>
      {#if !streamOnline}<p class="form-note" role="status">{receivedState ? 'Live connection lost. Mission state may be out of date.' : 'Connecting to the local server…'}</p>{/if}
      {#if mission.id}
        <section class="continue-card" aria-labelledby="current-chat-heading">
          <div class="section-heading"><span class="eyebrow">CURRENT CHAT</span><span class="home-status" role="status">{status}</span></div>
          <div class="continue-content">
            <div><h2 id="current-chat-heading">{mission.title}</h2><p title={mission.project}>{mission.project}</p></div>
            <button onclick={() => view = 'chat'}>{attention.length ? 'Review request' : 'Continue chat'} <span aria-hidden="true">→</span></button>
          </div>
          {#if running}<p class="form-note">Work continues here. Open this chat to follow progress or stop it.</p>{/if}
        </section>
      {/if}
      <section class="chat-history" aria-labelledby="saved-missions-heading">
        <div class="section-heading"><h2 id="saved-missions-heading">Saved chats <span class="chat-count">{savedChats.length}</span></h2><span class="history-order">Latest first</span></div>
        {#if savedChats.length}
          <div class="chat-filters">
            <input type="search" aria-label="Search saved chats" placeholder="Search chats or folders…" bind:value={chatSearch} />
            <select aria-label="Filter chats by project" bind:value={chatProject}>
              <option value="">All projects</option>
              {#each projects as path (path)}<option value={path}>{path}</option>{/each}
            </select>
          </div>
          {#if running || mission.execution === 'unknown'}<p class="form-note">{running ? 'Stop the current work before opening another chat.' : 'Reconnect to confirm the work status before opening another chat.'}</p>{/if}
          <ul class="chat-list">
            {#each filteredChats as saved (saved.id)}
              <li><button class="chat-row" disabled={pending || !streamOnline || running || mission.execution === 'unknown'} onclick={() => openMission(saved.id)}>
                <span class="chat-row-content"><strong>{saved.title}</strong><span class="chat-project-path" title={saved.project}>{saved.project}</span></span>
                <span class="chat-row-meta"><time datetime={new Date(saved.updated).toISOString()} title={new Date(saved.updated).toLocaleString()}>{updatedDate(saved.updated)}</time><span>{savedStatus(saved.execution)}</span></span>
                <span class="chat-row-arrow" aria-hidden="true">→</span>
              </button></li>
            {:else}
              <li class="chat-empty"><h3>No matching chats</h3><p>Try another search or project.</p><button class="text-button" onclick={() => { chatSearch = ''; chatProject = ''; }}>Clear filters</button></li>
            {/each}
          </ul>
        {:else}
          <div class="chat-empty"><h3>{mission.id ? 'Your other chats will appear here' : 'Start your first chat'}</h3><p>Choose New chat and select a local folder to get started.</p></div>
        {/if}
      </section>
      {#if mission.persistenceError}<p role="alert" class="error-banner">{mission.persistenceError}</p>{/if}
      <section class="home-projects" aria-labelledby="home-projects-heading">
        <h2 id="home-projects-heading">Projects</h2>
        <div class="home-project-list">
          {#each projects as path (path)}
            <button class="home-project" disabled={pending || !streamOnline || running || mission.execution === 'unknown'} onclick={() => beginNew(path)}><strong>{path.split('/').at(-1)}</strong><span>{path}</span><small>New chat →</small></button>
          {:else}<p class="form-note">Open a local folder to begin. Projects with saved chats appear here.</p>{/each}
        </div>
      </section>
      {#if error}<p role="alert" class="error-banner">{error}</p>{/if}
    </main>
  {:else}
  <main class="workspace mission-workspace">
    <aside class="left-rail" aria-label="Navigation and activity">
      <div class="section-heading"><button class="text-button back-home" onclick={goHome}>← Home</button></div>
      {#if mission.decisions?.some(d => d.disposition !== 'dismissed')}
        <section class="decisions-panel hud-widget" aria-label="Decisions">
          <h2>Decisions</h2>
          <div class="decision-list">
            {#each mission.decisions.filter(d => d.disposition !== 'dismissed') as decision (decision.id)}
              <button class="decision-link" onclick={() => selectedDecisionId = decision.id} aria-label={`${decision.disposition === 'confirmed' ? 'Confirmed' : 'Proposed'} decision: ${decision.text}`}>
                <span>{decision.text}</span>
                <small>{decision.delivery?.status === 'sending' ? 'Sending…' : decision.delivery?.status === 'accepted' ? 'Confirmed · sent' : decision.delivery?.status === 'uncertain' ? 'Delivery uncertain' : decision.disposition === 'confirmed' ? 'Confirmed · local only' : 'Needs confirmation'} <span aria-hidden="true">›</span></small>
              </button>
            {/each}
          </div>
        </section>
      {/if}


      {#if recentActivities.length}
      <section class="activity-panel hud-widget">
        <div class="section-heading"><h2>Recent activity</h2></div>
        <div class="activity-list">
          {#each recentActivities as activity (activity.id)}
            <div class="activity">
              <span class="activity-summary">{activityContext(activity).title} <span>{awaiting(activity) ? 'Needs you' : activity.status === 'inProgress' && !connected ? 'Stale' : label(activity.status)}{activity.details.exitCode != null ? ` · exit ${activity.details.exitCode}` : ''}</span></span>
              <span class="activity-title">{activityContext(activity).detail}</span>
            </div>
          {/each}
        </div>
        {#if mission.activities.length > 3}<button class="text-button" onclick={() => showAllActivity = !showAllActivity}>{showAllActivity ? 'Show less' : `All activity (${mission.activities.length})`}</button>{/if}
      </section>
      {/if}
    </aside>

    <section class="center" aria-label="Project conversation">
      <section class="mission-panel hud-widget" class:chat-heading={!mission.objective}>

        <div class="mission-heading-row"><p class="project-name">Current Mission</p>{#if mission.goalHistory && mission.goalHistory.length > 1}<details class="goal-history"><summary><span>History</span><span class="history-count">{mission.goalHistory.length - 1}</span></summary><div class="history-popover"><p class="history-heading">Previous missions</p>{#each [...mission.goalHistory].reverse().slice(1) as revision (revision.version)}<div><strong>{revision.title}</strong><p>{revision.description}</p><small>{revision.author === 'agent' ? 'Player Two' : revision.author === 'user' ? 'You' : 'Previously pinned'} · {new Date(revision.time).toLocaleString()}</small></div>{/each}</div></details>{/if}</div>
        <h1>{currentGoal?.title || (mission.goalToolAvailable ? 'New chat' : mission.id ? mission.title : 'New chat')}</h1>
        {#if currentGoal}
          {#if currentGoal.delivery}<p class="goal-attribution" role="status">{currentGoal.delivery.status === 'sending' ? 'Sending correction…' : currentGoal.delivery.status === 'accepted' ? 'Correction accepted by App Server' : 'Delivery uncertain. Reconnect to check before sending again.'}</p>{/if}
        {:else if mission.objective}
          <details class="objective-disclosure"><summary>Previously pinned objective</summary><div class="objective-block"><p>{mission.objective}</p></div></details>
        {/if}
        {#if mission.id && !currentGoal}
          <div class="goal-controls"><button class="text-button" disabled={pending || !connected || running && mission.execution !== 'working'} onclick={editGoal}>Set mission</button></div>
        {/if}

      </section>
        <div class="chat" bind:this={chatElement} onscroll={() => { if (chatElement) follow = chatElement.scrollHeight - chatElement.scrollTop - chatElement.clientHeight < 80; }} role="log" aria-label="Conversation">
          {#each messageGroups as group (group.id)}
            <article class="message" class:human={group.role === 'user'}>
              <div class="message-meta"><span class="avatar">{group.role === 'user' ? 'Y' : 'Ⅱ'}</span><strong>{group.role === 'user' ? 'You' : 'Player Two'}</strong></div>
              <div class="message-group-body">
                {#each group.messages as message (message.id)}
                  <div class="message-entry" class:decision-message={message.phase === 'decision_proposal'} id={`message-${message.id}`} tabindex="-1" class:decision-highlight={highlightedMessage === message.id}>
                    {#if message.phase === 'decision_proposal'}
                      {@const decision = mission.decisions?.find(d => d.messageId === message.id)}
                      <div class="decision-message-heading"><span>Decision</span><span>{decision?.disposition === 'confirmed' ? 'Confirmed by you' : decision?.disposition === 'dismissed' ? 'Dismissed' : 'Proposed by Player Two'}</span></div>
                    {/if}
                    {#if message.phase === 'steering_accepted'}<span class="steering-label">STEERING ACCEPTED</span>{/if}
                    <div class="message-text">{message.text || '…'}</div>{#if message.phase === 'steering_accepted'}<p class="steering-receipt">Accepted by App Server. Not yet observed in the agent’s conversation; it may not have been applied.</p>{/if}

                  </div>
                {/each}
              </div>
            </article>
          {:else}<div class="chat-empty">
            {#if mission.id}<p>Waiting for Codex events.</p>{:else}
              <p>Ask a question, explore an idea, or give Codex something to do.</p>
              <button onclick={chooseFolder}>{project ? 'Change project folder' : 'Choose a project folder'}</button>
              {#if project}<p class="chat-project-path">{project}</p>{/if}
              <details class="chat-project-settings" bind:open={permissionsOpen}>
                <summary>Permissions</summary>
                <div class="setup-permissions">
                  <label for="sandbox">Allow Player Two to</label>
                  <select id="sandbox" bind:value={sandbox} disabled={pending}>
                    <option value="workspace-write">Edit files in this project</option>
                    <option value="read-only">Read only · request approval for changes</option>
                  </select>
                </div>
              </details>
            {/if}
          </div>{/each}
          {#if mission.execution === 'interrupted'}<div class="turn-marker">Work stopped <span>Existing file changes are preserved.</span></div>{/if}
          {#if mission.execution === 'failed'}<div class="turn-marker failed">Response failed <span>Inspect the error and activity before retrying.</span></div>{/if}
        </div>
        {#if !follow && messageGroups.length}<button class="jump" onclick={async () => { follow = true; await tick(); if (chatElement) chatElement.scrollTop = chatElement.scrollHeight; }}>Latest messages ↓</button>{/if}
        {@render approvalRequests(mission.attention.filter(r => r.method !== 'item/commandExecution/requestApproval'))}
        <form class="composer" onsubmit={send}>
          <label class="sr-only" for="draft">{!mission.id ? 'Message Player Two' : running ? 'Update the current instructions' : 'Follow-up instruction'}</label>
          <textarea id="draft" bind:value={draft} placeholder={!mission.id ? 'Message Player Two…' : running ? 'Update the instructions…' : 'Message Player Two…'} rows="2" maxlength={mission.id ? 20000 : 12000} disabled={mission.id ? !connected : !streamOnline} onkeydown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!event.repeat && !sendDisabled) event.currentTarget.form?.requestSubmit(); } }}></textarea>
          <div class="composer-footer">{#if connected && (stopping || mission.execution === 'stopping')}<span class="composer-stop-status" role="status">Stopping…</span>{:else if connected && running && mission.turnId}<button type="button" class="stop-button composer-stop" aria-label="Stop Player Two" onclick={stop}>■ Stop</button>{/if}<button class="primary" disabled={sendDisabled}>{pending ? 'Sending…' : !mission.id ? 'Send ↑' : running ? 'Update instructions ↑' : 'Send ↑'}</button></div>
        </form>
      {#if mission.persistenceError}<p role="alert" class="error-banner">{mission.persistenceError}</p>{/if}
        {#if error || mission.error}<div class="error-banner" role="alert"><strong>Something needs attention</strong><p>{error || mission.error}</p>{#if mission.diagnostics}<details><summary>Server diagnostics</summary><pre>{mission.diagnostics}</pre></details>{/if}{#if error}<button class="text-button" onclick={() => error = ''}>Dismiss local message</button>{/if}</div>{/if}
    </section>

    <aside class="right-rail" aria-label="Next steps and execution">
      {#if mission.proposals.length}
        <details class="next-panel compact-proposals hud-widget">
          <summary>Next steps <span>{mission.proposals.filter(p => p.disposition === 'proposed').length} new</span></summary>
          <p class="panel-caption">Proposed by Codex. Not agreed work.</p>
          {#each mission.proposals as proposal (proposal.id)}
            <div class="proposal" class:muted={proposal.disposition === 'dismissed'}><span class="micro-label">{proposal.disposition}</span><p>{proposal.text}</p>{#if proposal.disposition === 'proposed'}<div><button class="text-button" onclick={() => perform({ action: 'proposal', id: proposal.id, disposition: 'noted' })}>Note this</button><button class="text-button" onclick={() => perform({ action: 'proposal', id: proposal.id, disposition: 'dismissed' })}>Dismiss</button></div>{/if}</div>
          {/each}
          <p class="form-note">Noting a proposal does not start work or change your objective.</p>
        </details>
      {/if}
      <div class="execution-stack">
      {@render approvalRequests(mission.attention.filter(r => r.method === 'item/commandExecution/requestApproval'))}
      <section class="execution-panel hud-widget" class:attention-widget={attention.length > 0 || pendingDecisions.length > 0 || (!!mission.id && !connected)}>
        <div class="eyebrow"><span class="hud-indicator" class:connected={connected && running} aria-hidden="true"></span>Activity now</div>
        <div class="execution-status" class:needs-input={attention.length > 0} aria-live="polite"><h2>{!mission.id ? (streamOnline ? 'Ready to chat' : 'Connecting…') : !connected ? status : attention.length ? 'Needs your input' : latestOperation ? operationDescription(latestOperation) : mission.execution === 'working' ? 'Player Two is working' : status}</h2></div>
        {#if !streamOnline && mission.id}<p class="current-context">The interface lost its connection. This view may be out of date.</p>
        {:else if mission.connection === 'lost'}<p class="current-context">App Server disconnected. Reconnect to find out where work stopped.</p>
        {:else if attention.length}<p class="current-context">{attention.length === 1 ? 'One request is waiting' : `${attention.length} requests are waiting`}. Review {attention[0].method === 'item/commandExecution/requestApproval' ? 'the command above' : 'the request beside the conversation'}.</p>
        {:else if connected && latestOperation}<p class="your-turn">{pendingDecisions.length ? `${pendingDecisions.length} decision(s) need your confirmation.` : 'No response requested.'}</p>
        {:else if mission.execution === 'working'}<p class="current-context">No tool is currently running.</p><p class="your-turn">{pendingDecisions.length ? `${pendingDecisions.length} decision(s) need your confirmation.` : 'No response requested.'}</p>
        {:else if mission.execution === 'interrupted'}<p class="current-context">Work has stopped. File changes are preserved.</p>
        {:else if !mission.id}<p class="current-context">Nothing is running yet.</p>{/if}
        {#if pendingDecisions.length}<button class="text-button" onclick={() => selectedDecisionId = pendingDecisions[0].id}>Review decision ({pendingDecisions.length}) →</button>{/if}
        {#if connected && activeItems.length > 1}<details class="other-operations"><summary>{activeItems.length - 1} other active operations</summary>{#each activeItems.filter(a => a.id !== latestOperation?.id) as item (item.id)}<p>{operationDescription(item)}</p>{/each}</details>{/if}
        {#if mission.id && (mission.connection === 'lost' || mission.execution === 'unknown')}<div class="mission-controls"><button disabled={pending || !streamOnline} onclick={() => perform({ action: 'reconnect' })}>Reconnect & check status</button></div>{/if}
      </section>
      </div>
    </aside>
  </main>
  {/if}
</div>

<dialog bind:this={folderPicker} class="folder-picker" aria-labelledby="folder-heading">
  <div class="section-heading"><h2 id="folder-heading">Choose a project folder</h2><button type="button" onclick={() => folderPicker?.close()}>Close ×</button></div>
  <form class="folder-location" onsubmit={(event) => { event.preventDefault(); void browseFolders(folderInput); }}>
    <label for="folder-path" class="sr-only">Folder path</label><input id="folder-path" bind:value={folderInput} placeholder="Paste a folder path" disabled={folderLoading} /><button disabled={folderLoading}>Open</button>
  </form>
  {#if folderError}<p class="folder-error" role="alert">{folderError}</p>{/if}
  <div class="folder-list" aria-busy={folderLoading}>
    {#if folderLoading}<p role="status">Opening folder…</p>{:else}
      {#if folderPath !== folderParent}<button type="button" onclick={() => browseFolders(folderParent)}>↑ Parent folder</button>{/if}
      {#each folders as folder (folder.path)}<button type="button" onclick={() => browseFolders(folder.path)}><span>{folder.name}</span><span aria-hidden="true">›</span></button>{/each}
      {#if !folders.length && folderPath}<p>No visible subfolders.</p>{/if}
    {/if}
  </div>
  <div class="folder-footer"><p>{folderPath || 'Select a local folder. Nothing starts until you submit your task.'}</p><button class="primary" disabled={folderLoading || !folderPath || !!folderError} onclick={() => { project = folderPath; folderPicker?.close(); }}>Use this folder</button></div>
</dialog>

{#if selectedDecision}
  <dialog use:openInspector class="decision-inspector" aria-labelledby="decision-title" onclose={() => selectedDecisionId = null}>
    <div class="section-heading"><h2 id="decision-title">Decision</h2><button onclick={() => selectedDecisionId = null}>Close ×</button></div>
    <p class="panel-caption">{selectedDecision.disposition === 'confirmed' ? 'Proposed by Player Two · Confirmed by you' : 'Proposed by Player Two · Awaiting your confirmation'}</p>
    <p class="decision-detail">{selectedDecision.text}</p>
    {#if selectedDecision.delivery}<p class="decision-delivery" role="status">{selectedDecision.delivery.status === 'sending' ? 'Sending to Codex…' : selectedDecision.delivery.status === 'accepted' ? 'Accepted by App Server. This does not establish that Codex has understood or applied the choice.' : 'Delivery uncertain. Check the conversation before sending again.'}</p>{#if selectedDecision.delivery.error}<p class="form-note">{selectedDecision.delivery.error}</p>{/if}
    {:else if selectedDecision.disposition === 'confirmed'}<p class="form-note">Recorded locally before delivery was supported. Not sent to Codex.</p>{/if}
    <button class="text-button" onclick={async () => { const id = selectedDecision.messageId; selectedDecisionId = null; await showDecision(id); }}>View in conversation ↗</button>
    <div class="decision-actions">
      <button disabled={pending || !streamOnline} onclick={async () => { await perform({ action: 'decision', id: selectedDecision.id, disposition: 'dismissed' }); if (!error) selectedDecisionId = null; }}>{selectedDecision.disposition === 'confirmed' ? 'Remove decision' : 'Dismiss'}</button>
      {#if selectedDecision.disposition === 'proposed'}<button class="primary" disabled={pending || !connected || !!selectedDecision.delivery || ['starting', 'stopping', 'unknown'].includes(mission.execution) || attention.length > 0} onclick={() => perform({ action: 'decision', id: selectedDecision.id, disposition: 'confirmed' })}>Confirm &amp; send</button>{/if}
    </div>
    {#if error}<p role="alert">{error}</p>{/if}
  </dialog>
{/if}

{#if editingGoal}
  <dialog use:openInspector class="folder-picker" aria-labelledby="goal-edit-heading" onclose={() => editingGoal = false}>
    <div class="section-heading"><h2 id="goal-edit-heading">Correct the mission</h2><button onclick={() => editingGoal = false}>Close ×</button></div>
    <p class="form-note">Your correction is sent to Codex in this conversation. It does not grant additional permissions.</p>
    {#if !mission.goalToolAvailable}<p class="form-note">This older chat does not have the mission-update tool. You can still correct its goal here.</p>{/if}
    <form onsubmit={sendGoal}>
      <label for="goal-title">Short title</label><input id="goal-title" bind:value={goalTitle} maxlength="80" required />
      <label for="goal-description">What we’re working toward</label><textarea id="goal-description" bind:value={goalDescription} maxlength="300" rows="3" required></textarea>
      {#if error}<p role="alert" class="form-note">{error}</p>{/if}
      <div class="decision-actions"><button type="submit" class="primary" disabled={pending || !connected || !goalTitle.trim() || !goalDescription.trim() || ['starting', 'stopping', 'unknown'].includes(mission.execution) || attention.length > 0}>Edit &amp; send</button></div>
    </form>
  </dialog>
{/if}

import { useEffect, useState, type ReactElement } from 'react';

export interface ElricPendingAction {
  id: string;
  tool: string;
  summary: string | null;
  args_hash: string;
  room: { id: string; name: string } | null;
  created_at: string;
  expires_at: string;
}

export interface ElricApprovalCardProps {
  pendingId: string;
}

const TOOL_LABELS: Record<string, string> = {
  room_task_create: 'Create a task',
  create_room_task: 'Create a task',
  city_room_task_create: 'Create a task',
  room_task_update: 'Update a task',
  update_room_task: 'Update a task',
  city_room_task_update: 'Update a task',
  room_task_delete: 'Delete a task',
  delete_room_task: 'Delete a task',
  city_room_task_delete: 'Delete a task',
  room_task_claim: 'Claim a task',
  claim_room_task: 'Claim a task',
  city_room_task_claim: 'Claim a task',
  room_task_release: 'Release a task',
  release_room_task: 'Release a task',
  city_room_task_release: 'Release a task',
  room_task_result: 'Submit task result',
  city_room_task_result: 'Submit task result',
  room_task_review: 'Review a task',
  city_room_task_review: 'Review a task',
  room_task_renew: 'Renew task lease',
  city_room_task_renew: 'Renew task lease',
};

function formatTool(tool?: string | null): string | null {
  if (!tool) return null;
  return TOOL_LABELS[tool] ?? null;
}

function formatRemaining(totalSeconds: number): string {
  if (totalSeconds <= 0) return 'Expired';
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Inline approval card rendered under Elric's "Waiting for your approval." message.
 * Displays exact action (tool, title, room), live countdown to expiry, and
 * Approve / Reject buttons wired to /api/elric/pending endpoints.
 */
export function ElricApprovalCard({ pendingId }: { pendingId: string }): ReactElement | null {
  const [item, setItem] = useState<ElricPendingAction | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch('/api/elric/pending', {
          headers: { 'X-City-Request': '1' },
        });
        if (!res.ok) {
          if (active) setLoading(false);
          return;
        }
        const data = (await res.json()) as { pending?: ElricPendingAction[] };
        const found = data.pending?.find((p) => p.id === pendingId);
        if (active) {
          setItem(found ?? null);
          setLoading(false);
        }
      } catch {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [pendingId]);

  useEffect(() => {
    if (!item?.expires_at || decision) return;
    function update() {
      const diff = Math.max(
        0,
        Math.floor((new Date(item!.expires_at).getTime() - Date.now()) / 1000),
      );
      setRemainingSeconds(diff);
    }
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [item?.expires_at, decision]);

  if (loading || (!item && !decision)) {
    return null;
  }

  const expired = remainingSeconds <= 0 && !decision;
  const toolLabel = formatTool(item?.tool);

  async function handleApprove() {
    if (!item || busy || expired) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/elric/pending/${encodeURIComponent(item.id)}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-City-Request': '1',
        },
        body: JSON.stringify({ args_hash: item.args_hash }),
      });
      if (res.ok) {
        setDecision('approved');
      } else {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(data.message || 'Could not approve action.');
      }
    } catch {
      setError('Could not approve action.');
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!item || busy || expired) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/elric/pending/${encodeURIComponent(item.id)}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-City-Request': '1',
        },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setDecision('rejected');
      } else {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(data.message || 'Could not reject action.');
      }
    } catch {
      setError('Could not reject action.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`rm-approval-card${decision ? ` decided ${decision}` : ''}${expired ? ' expired' : ''}`}
      data-testid="elric-approval-card"
      role="region"
      aria-label="Pending approval"
    >
      <div className="rm-approval-header">
        {toolLabel ? <span className="rm-approval-tool">{toolLabel}</span> : null}
        {!decision ? (
          <span className="rm-approval-countdown" data-testid="approval-countdown">
            {expired ? 'Expired' : `${formatRemaining(remainingSeconds)} remaining`}
          </span>
        ) : null}
      </div>

      <div className="rm-approval-body">
        {item?.summary ? (
          <strong className="rm-approval-title" data-testid="approval-title">
            {item.summary}
          </strong>
        ) : null}
        <div className="rm-approval-meta">
          <span className="rm-approval-room" data-testid="approval-room">
            {item?.room?.name ? `Room: ${item.room.name}` : 'This room'}
          </span>
        </div>
      </div>

      {error ? (
        <p className="rm-error rm-approval-error" role="alert">
          {error}
        </p>
      ) : null}

      {decision ? (
        <div className="rm-approval-decided">
          <span
            className={`rm-approval-status ${decision}`}
            data-testid={`approval-status-${decision}`}
          >
            {decision === 'approved' ? 'Approved' : 'Rejected'}
          </span>
        </div>
      ) : !expired ? (
        <div className="rm-approval-actions">
          <button
            type="button"
            className="rm-btn-sm rm-quiet"
            onClick={handleReject}
            disabled={busy}
            data-testid="approval-reject"
          >
            Reject
          </button>
          <button
            type="button"
            className="rm-btn-sm rm-primary"
            onClick={handleApprove}
            disabled={busy}
            data-testid="approval-approve"
          >
            {busy ? 'Approving…' : 'Approve'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

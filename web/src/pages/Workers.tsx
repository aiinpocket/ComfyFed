import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconCopy,
  IconDownload,
  IconPlus,
  IconRefresh,
  IconServerOff,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { Fragment, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { ApiError, api, peerReachable, type Role, type TokenBundle, type Worker } from '../api';
import { EmptyState, Mono, SectionHeader, TableSkeleton } from '../components/Primitives';
import { WorkerStatusBadge } from '../components/StatusBadge';
import { formatAbsolute, formatGb, formatRelative, shortId } from '../lib/format';
import { usePolling } from '../lib/usePolling';

const POLL_MS = 10000;

interface WorkersProps {
  /** `GET /api/workers` is now a read-only listing any logged-in user may
   * load (workers are shared infrastructure), so every role renders this
   * page. Only admins see the mutation controls -- add/disable/delete -- and
   * those endpoints stay admin-gated server-side regardless: a non-admin must
   * never see a control whose API would 403. */
  role: Role;
}

/** Phase 3.4：P2P 欄的一格 —— 開埠方式、對外位址、可連性徽章。
 * `peer_url` 為 null（沒開分享）就只顯示「關閉」。 */
/** 2026-09-24: the agent (client) version a worker reported in its hello,
 * with an "outdated" badge when it is behind the platform's published
 * `latest` (dotted-integer compare; anything unparsable never flags). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10));
  const pb = b.split('.').map((x) => Number.parseInt(x, 10));
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Spec 2026-09-24 §2.2: a row gets the「更新」button only when the platform
 * can actually reach the agent (a live socket, so not `offline`; not
 * disabled -- the hub would refuse it anyway) AND its reported version is
 * behind the published latest. An agent that never reported a version can't
 * be judged, so it never qualifies. */
function canRemoteUpdate(worker: Worker, latest: string | null): boolean {
  const version = worker.hardware?.agent_version;
  if (!version || latest == null) return false;
  if (worker.disabled || worker.status === 'offline') return false;
  return compareVersions(version, latest) < 0;
}

const UPDATE_STATUSES = ['updating', 'deferred', 'up_to_date', 'declined', 'failed', 'sent'] as const;

/** The i18n key for one `update_ack` status; an unexpected value from a
 * newer server falls back to `sent` (the honest "we don't know yet"). */
function updateStatusKey(status: string): string {
  const known = (UPDATE_STATUSES as readonly string[]).includes(status) ? status : 'sent';
  return `workers.update_status.${known}`;
}

/** The message for a failed `updateWorker` call: the two 409 codes the route
 * defines get their own wording; anything else shows the server's message
 * (or the generic network line). */
function updateErrorMessage(caught: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!(caught instanceof ApiError)) return t('errors.network');
  if (caught.code === 'workers.agent_too_old') return t('workers.agent_too_old');
  if (caught.code === 'workers.offline') return t('workers.offline');
  return t(`errors.${caught.code}`, { defaultValue: caught.message });
}

/** One `updateWorker` call for the「全部更新」sweep, reduced to "did the
 * command land": every ack except `failed` counts as sent, and a rejected
 * request (offline, too old, network) counts as failed. Never throws. */
async function sendUpdate(workerId: string): Promise<boolean> {
  try {
    const result = await api.updateWorker(workerId);
    return result.status !== 'failed';
  } catch {
    return false;
  }
}

function AgentVersionCell({ version, latest }: { version?: string | null; latest: string | null }) {
  const { t } = useTranslation();
  if (!version) {
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  }
  const outdated = latest != null && compareVersions(version, latest) < 0;
  return (
    <Group gap={6} wrap="nowrap">
      <Mono size="sm">{version}</Mono>
      {outdated && (
        <Badge color="orange" variant="light" size="sm" tt="none" fw={500} title={t('workers.agent_outdated_hint', { latest })}>
          {t('workers.agent_outdated')}
        </Badge>
      )}
    </Group>
  );
}

function P2pCell({ worker }: { worker: Worker }) {
  const { t } = useTranslation();
  if (!worker.peer_url) {
    return (
      <Text size="xs" c="dimmed">
        {t('workers.p2p_off')}
      </Text>
    );
  }
  const natKey = `workers.p2p_nat_${worker.peer_nat}`;
  const natLabel = worker.peer_nat === 'none' ? t('workers.p2p_off') : t(natKey);
  const reachable = peerReachable(worker.peer_reachable);
  const reach =
    reachable === true
      ? { color: 'green', label: t('workers.p2p_verified') }
      : reachable === false
        ? { color: 'red', label: t('workers.p2p_unreachable') }
        : { color: 'gray', label: t('workers.p2p_unchecked') };
  return (
    <Stack gap={2}>
      <Text size="xs">{natLabel}</Text>
      <Mono size="xs" title={worker.peer_url}>
        {worker.peer_url}
      </Mono>
      {worker.peer_lan_url && worker.peer_lan_url !== worker.peer_url && (
        <Mono size="xs" c="dimmed" title={worker.peer_lan_url}>
          {t('workers.p2p_lan_label')} {worker.peer_lan_url}
        </Mono>
      )}
      <Badge color={reach.color} variant="light" size="sm" tt="none" fw={500}>
        {reach.label}
      </Badge>
    </Stack>
  );
}

/**
 * Job-retry design (2026-09-19) §7/§8: the tasks this worker has been
 * repeatedly excluded from. `task_key` is a hash (job.signature, or
 * `model_fetch:<name>`) so only its first 12 characters are shown, with the
 * full value in a `title` tooltip; same idea for `last_error` at 120 chars.
 * A row past its TTL (`active: false`) renders dimmed with an "Expired"
 * badge rather than disappearing outright -- it's informational only, no
 * longer affects dispatch. Admin-only clear buttons call the DELETE routes
 * and refresh the worker list on success.
 */
function UnsuitableBlock({
  worker,
  isAdmin,
  onCleared,
}: {
  worker: Worker;
  isAdmin: boolean;
  onCleared: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [clearingKey, setClearingKey] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);

  const notifyFailure = (caught: unknown) =>
    notifications.show({
      color: 'red',
      icon: <IconX size={16} />,
      title: t('workers.unsuitable_clear_failed'),
      message:
        caught instanceof ApiError
          ? t(`errors.${caught.code}`, { defaultValue: caught.message })
          : t('errors.network'),
    });

  const clearOne = async (taskKey: string) => {
    setClearingKey(taskKey);
    try {
      await api.clearUnsuitable(worker.id, taskKey);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('workers.unsuitable_cleared'),
        message: worker.name,
      });
      await onCleared();
    } catch (caught) {
      notifyFailure(caught);
    } finally {
      setClearingKey(null);
    }
  };

  const clearAll = async () => {
    setClearingAll(true);
    try {
      await api.clearUnsuitable(worker.id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('workers.unsuitable_cleared'),
        message: worker.name,
      });
      await onCleared();
    } catch (caught) {
      notifyFailure(caught);
    } finally {
      setClearingAll(false);
    }
  };

  return (
    <Stack gap="xs" py={4}>
      <Group justify="space-between" gap="sm">
        <Text size="xs" fw={600} c="dimmed">
          {t('workers.unsuitable_heading')}
        </Text>
        {isAdmin && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            loading={clearingAll}
            onClick={() => void clearAll()}
          >
            {t('workers.unsuitable_clear_all')}
          </Button>
        )}
      </Group>
      <Table verticalSpacing={4} horizontalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('workers.unsuitable_col_key')}</Table.Th>
            <Table.Th>{t('workers.unsuitable_col_failures')}</Table.Th>
            <Table.Th>{t('workers.unsuitable_col_last_error')}</Table.Th>
            <Table.Th>{t('workers.unsuitable_col_updated')}</Table.Th>
            {isAdmin && <Table.Th />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {worker.unsuitable.map((entry) => (
            <Table.Tr key={entry.task_key} opacity={entry.active ? 1 : 0.55}>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  <Mono size="xs" title={entry.task_key}>
                    {entry.task_key.slice(0, 12)}
                  </Mono>
                  {!entry.active && (
                    <Badge color="gray" variant="light" size="sm" tt="none" fw={500}>
                      {t('workers.unsuitable_expired')}
                    </Badge>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{entry.failures}</Text>
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="xs" title={entry.last_error ?? undefined} lineClamp={2}>
                    {entry.last_error ? entry.last_error.slice(0, 120) : '—'}
                  </Text>
                  {entry.last_job_id && (
                    <Anchor component={Link} to={`/jobs/${entry.last_job_id}`} size="xs">
                      {t('workers.unsuitable_last_job_link')}
                    </Anchor>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {formatAbsolute(entry.updated_at)}
                </Text>
              </Table.Td>
              {isAdmin && (
                <Table.Td>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    loading={clearingKey === entry.task_key}
                    onClick={() => void clearOne(entry.task_key)}
                  >
                    {t('workers.unsuitable_clear')}
                  </Button>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

export function Workers({ role }: WorkersProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isAdmin = role === 'admin';

  const loader = useCallback(() => api.listWorkers(), []);
  const { data, loading, error, refresh } = usePolling(loader, POLL_MS);
  const workers = data ?? [];

  const [addOpen, setAddOpen] = useState(false);
  const [wheelUrl, setWheelUrl] = useState<string | null>(null);
  // 2026-09-24: latest published agent version, to flag outdated workers.
  const [latestAgent, setLatestAgent] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .agentVersion()
      .then((v) => {
        if (!cancelled) {
          setWheelUrl(v.wheel_url);
          setLatestAgent(v.latest || null);
        }
      })
      .catch(() => {
        /* no published wheel (or older server) -- just hide the button */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [confirmTarget, setConfirmTarget] = useState<Worker | null>(null);
  const [disabling, setDisabling] = useState(false);

  const disable = async () => {
    if (!confirmTarget) return;
    setDisabling(true);
    try {
      await api.disableWorker(confirmTarget.id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('workers.disabled_title'),
        message: t('workers.disabled_message', { name: confirmTarget.name }),
      });
      setConfirmTarget(null);
      await refresh();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('workers.disable_failed'),
        message:
          caught instanceof ApiError
            ? t(`errors.${caught.code}`, { defaultValue: caught.message })
            : t('errors.network'),
      });
    } finally {
      setDisabling(false);
    }
  };

  // Soft delete: the row disappears from this list for good (and the worker
  // can never reconnect), but its receipts stay in the billing reports --
  // hence a separate confirm from `disable`, spelling that out. The page is
  // now open to every role (see App.tsx), so this action -- like disable and
  // add-worker -- is rendered only for admins (`isAdmin` below); the endpoint
  // is admin-gated server-side too, so a non-admin never sees a 403 control.
  const [deleteTarget, setDeleteTarget] = useState<Worker | null>(null);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteWorker(deleteTarget.id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('workers.deleted_title'),
        message: t('workers.deleted_message', { name: deleteTarget.name }),
      });
      setDeleteTarget(null);
      await refresh();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('workers.delete_failed'),
        message:
          caught instanceof ApiError
            ? t(`errors.${caught.code}`, { defaultValue: caught.message })
            : t('errors.network'),
      });
    } finally {
      setDeleting(false);
    }
  };

  // Spec 2026-09-24 §2.2: remote agent update. `updatingIds` holds the rows
  // whose request is in flight (button disabled meanwhile); `updatingAll`
  // gates the header button while the sequential sweep runs.
  const [updatingIds, setUpdatingIds] = useState<ReadonlySet<string>>(new Set());
  const [updatingAll, setUpdatingAll] = useState(false);
  const updatable = workers.filter((w) => canRemoteUpdate(w, latestAgent));

  const markUpdating = (id: string, on: boolean) =>
    setUpdatingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const updateOne = async (worker: Worker) => {
    markUpdating(worker.id, true);
    try {
      const result = await api.updateWorker(worker.id);
      notifications.show({
        color: result.status === 'failed' ? 'red' : 'teal',
        icon: result.status === 'failed' ? <IconX size={16} /> : <IconCheck size={16} />,
        title: worker.name,
        message: t(updateStatusKey(result.status)),
      });
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('workers.update_failed'),
        message: updateErrorMessage(caught, t),
      });
    } finally {
      markUpdating(worker.id, false);
    }
  };

  // Sequential on purpose: each call may wait up to the hub's 15 s ack
  // deadline, and a fleet-wide burst of `update_agent` is exactly what the
  // per-worker `deferred` path is meant to smooth out. One summary
  // notification at the end instead of one per row.
  const updateAll = async () => {
    setUpdatingAll(true);
    try {
      const outcomes: boolean[] = [];
      for (const worker of updatable) {
        outcomes.push(await sendUpdate(worker.id));
      }
      const sent = outcomes.filter(Boolean).length;
      const failed = outcomes.length - sent;
      notifications.show({
        color: failed === 0 ? 'teal' : 'orange',
        icon: failed === 0 ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />,
        title: t('workers.update_all'),
        message: t('workers.update_all_done', { sent, failed }),
      });
    } finally {
      setUpdatingAll(false);
    }
  };

  return (
    <Stack gap="lg">
      <SectionHeader
        title={t('workers.title')}
        description={t('workers.subtitle')}
        action={
          <Group gap="sm">
            {wheelUrl && (
              <Button
                variant="default"
                component="a"
                href={wheelUrl}
                leftSection={<IconDownload size={16} />}
              >
                {t('workers.download_agent')}
              </Button>
            )}
            {isAdmin && updatable.length > 0 && (
              <Button
                variant="default"
                leftSection={<IconRefresh size={16} />}
                loading={updatingAll}
                onClick={() => void updateAll()}
              >
                {t('workers.update_all')}
              </Button>
            )}
            {isAdmin && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
                {t('workers.add')}
              </Button>
            )}
          </Group>
        }
      />

      {error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('workers.load_error')}
        </Alert>
      )}

      <Card
        padding={0}
        style={{
          background: theme.other.surfaces.card,
          borderColor: theme.other.surfaces.border,
          overflow: 'hidden',
        }}
      >
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : workers.length === 0 ? (
          <EmptyState
            icon={<IconServerOff size={26} />}
            title={t('workers.empty')}
            description={t('workers.empty_hint')}
            action={
              isAdmin ? (
                <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
                  {t('workers.add')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table.ScrollContainer
            // 1120 = the old 880 + the action column's growth (110 -> 210)
            // when the disable + delete pair replaced disable alone, +140 =
            // the Phase 3.4 P2P column.
            minWidth={1120}
          >
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
              <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                <Table.Tr>
                  <Table.Th>{t('workers.col_name')}</Table.Th>
                  <Table.Th>{t('workers.col_status')}</Table.Th>
                  <Table.Th>{t('workers.col_gpu')}</Table.Th>
                  <Table.Th>{t('workers.col_backend')}</Table.Th>
                  <Table.Th>{t('workers.col_models')}</Table.Th>
                  <Table.Th>{t('workers.col_agent')}</Table.Th>
                  <Table.Th>{t('workers.col_p2p')}</Table.Th>
                  <Table.Th>{t('workers.col_last_seen')}</Table.Th>
                  {/* Wide enough for update + disable + delete. Admin-only:
                      non-admins have no per-row actions, so no action column. */}
                  {isAdmin && <Table.Th w={300} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {workers.map((worker) => (
                  <Fragment key={worker.id}>
                  <Table.Tr opacity={worker.disabled ? 0.55 : 1}>
                    <Table.Td>
                      <Stack gap={1}>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" fw={500}>
                            {worker.name}
                          </Text>
                          {worker.peer_url && (
                            <Badge color="federation" variant="light" size="sm" tt="none" fw={500}>
                              {t('workers.p2p_sharing')}
                            </Badge>
                          )}
                        </Group>
                        <Mono size="xs" title={worker.id}>
                          {shortId(worker.id)}
                        </Mono>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <WorkerStatusBadge status={worker.status} disabled={worker.disabled} />
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={1}>
                        <Text size="sm" lineClamp={1}>
                          {worker.hardware?.gpu_name || '—'}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatGb(worker.hardware?.vram_gb)}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {worker.backend ? (
                        <Stack gap={1}>
                          <Badge size="sm" variant="light" tt="uppercase" fw={600}>
                            {worker.backend}
                          </Badge>
                          {worker.hardware?.platform && (
                            <Text size="xs" c="dimmed">
                              {worker.hardware.platform}
                            </Text>
                          )}
                        </Stack>
                      ) : (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {worker.model_count}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <AgentVersionCell version={worker.hardware?.agent_version} latest={latestAgent} />
                    </Table.Td>
                    <Table.Td>
                      <P2pCell worker={worker} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {formatRelative(worker.last_seen, t)}
                      </Text>
                    </Table.Td>
                    {isAdmin && (
                      <Table.Td>
                        <Group gap={4} wrap="nowrap" justify="flex-end">
                          {canRemoteUpdate(worker, latestAgent) && (
                            <Button
                              size="compact-sm"
                              variant="subtle"
                              leftSection={<IconRefresh size={14} />}
                              loading={updatingIds.has(worker.id)}
                              disabled={updatingAll}
                              onClick={() => void updateOne(worker)}
                            >
                              {t('workers.update')}
                            </Button>
                          )}
                          {!worker.disabled && (
                            <Button
                              size="compact-sm"
                              variant="subtle"
                              color="red"
                              leftSection={<IconBan size={14} />}
                              onClick={() => setConfirmTarget(worker)}
                            >
                              {t('workers.disable')}
                            </Button>
                          )}
                          {/* Deliberately NOT a second `variant="subtle"`
                              red button: delete is irreversible and sits right
                              next to disable, so it carries its own outline
                              weight to break the misclick pair. */}
                          <Button
                            size="compact-sm"
                            variant="outline"
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => setDeleteTarget(worker)}
                          >
                            {t('workers.delete')}
                          </Button>
                        </Group>
                      </Table.Td>
                    )}
                  </Table.Tr>
                  {worker.unsuitable.length > 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={isAdmin ? 8 : 7} style={{ background: theme.other.surfaces.raised }}>
                        <UnsuitableBlock worker={worker} isAdmin={isAdmin} onCleared={refresh} />
                      </Table.Td>
                    </Table.Tr>
                  )}
                  </Fragment>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {/* Every modal below drives an admin-only mutation and is reachable only
          through a control gated on `isAdmin` above; rendered under the same
          gate so a non-admin never mounts them at all. */}
      {isAdmin && (
        <>
      <AddWorkerModal opened={addOpen} onClose={() => setAddOpen(false)} onCreated={refresh} />

      <Modal
        opened={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        title={t('workers.confirm_title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">{t('workers.confirm_body', { name: confirmTarget?.name ?? '' })}</Text>
          <Text size="xs" c="dimmed">
            {t('workers.confirm_hint')}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConfirmTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button color="red" onClick={disable} loading={disabling}>
              {t('workers.disable')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('workers.delete_confirm_title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">{t('workers.delete_confirm', { name: deleteTarget?.name ?? '' })}</Text>
          <Text size="xs" c="dimmed">
            {t('workers.delete_confirm_hint')}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button color="red" onClick={remove} loading={deleting}>
              {t('workers.delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
        </>
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------ add + bundle */

interface AddWorkerModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function AddWorkerModal({ opened, onClose, onCreated }: AddWorkerModalProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState<TokenBundle | null>(null);

  const bundleText = bundle ? JSON.stringify(bundle, null, 2) : '';
  const platformUrl = (bundle?.platform_url || window.location.origin).replace(/\/+$/, '');

  const reset = () => {
    setName('');
    setBundle(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const issued = await api.issueWorkerToken(name.trim());
      setBundle(issued);
      onCreated();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('workers.create_failed'),
        message:
          caught instanceof ApiError
            ? t(`errors.${caught.code}`, { defaultValue: caught.message })
            : t('errors.network'),
      });
    } finally {
      setBusy(false);
    }
  };

  const downloadBundle = () => {
    const blob = new Blob([bundleText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `comfyfed-worker-${name.trim() || 'bundle'}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={t('workers.add_title')}
      size="lg"
      closeOnClickOutside={bundle === null}
      closeOnEscape={bundle === null}
    >
      {bundle === null ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t('workers.add_body')}
          </Text>
          <TextInput
            label={t('workers.name_label')}
            placeholder={t('workers.name_placeholder')}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create();
            }}
            data-autofocus
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button onClick={create} loading={busy} disabled={!name.trim()}>
              {t('workers.create')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          <Alert color="yellow" variant="light" p="sm" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm">{t('workers.bundle_warning')}</Text>
          </Alert>

          <Text size="sm" fw={500}>
            {t('workers.install_title')}
          </Text>
          <Stack gap="sm">
            <InstallCommandBlock
              label={t('workers.install_windows_ps')}
              command={`irm "${platformUrl}/install.ps1?token=${bundle.register_token}" | iex`}
            />
            <InstallCommandBlock
              label={t('workers.install_windows_cmd')}
              command={`curl -fsSL "${platformUrl}/install.cmd?token=${bundle.register_token}" -o install.cmd && install.cmd && del install.cmd`}
            />
            <InstallCommandBlock
              label={t('workers.install_unix')}
              command={`curl -fsSL "${platformUrl}/install.sh?token=${bundle.register_token}" | bash`}
            />
          </Stack>

          <Accordion variant="separated">
            <Accordion.Item value="manual">
              <Accordion.Control>{t('workers.manual_install')}</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="md">
                  <Text size="sm" c="dimmed">
                    {t('workers.bundle_body')}
                  </Text>
                  <Box
                    style={{
                      maxHeight: 260,
                      overflow: 'auto',
                      borderRadius: theme.radius.md,
                      border: `1px solid ${theme.other.surfaces.border}`,
                    }}
                  >
                    <Code block style={{ background: theme.other.surfaces.raised, fontSize: 12 }}>
                      {bundleText}
                    </Code>
                  </Box>
                  <Group gap="sm">
                    <CopyButton value={bundleText} timeout={1800}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? t('common.copied') : t('common.copy')}>
                          <Button
                            variant="light"
                            color={copied ? 'teal' : 'federation'}
                            leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                            onClick={copy}
                          >
                            {copied ? t('common.copied') : t('workers.copy_bundle')}
                          </Button>
                        </Tooltip>
                      )}
                    </CopyButton>
                    <Button leftSection={<IconDownload size={16} />} onClick={downloadBundle}>
                      {t('workers.download_bundle')}
                    </Button>
                  </Group>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>

          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common.done')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

interface InstallCommandBlockProps {
  label: string;
  command: string;
}

function InstallCommandBlock({ label, command }: InstallCommandBlockProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  return (
    <Box>
      <Group justify="space-between" gap="sm" mb={4}>
        <Badge variant="light" tt="none" fw={500}>
          {label}
        </Badge>
        <CopyButton value={command} timeout={1800}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? t('common.copied') : t('common.copy')}>
              <Button
                size="compact-xs"
                variant="subtle"
                color={copied ? 'teal' : 'federation'}
                leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                onClick={copy}
              >
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
      <Box
        style={{
          overflowX: 'auto',
          borderRadius: theme.radius.md,
          border: `1px solid ${theme.other.surfaces.border}`,
        }}
      >
        <Code block style={{ background: theme.other.surfaces.raised, fontSize: 12, whiteSpace: 'pre' }}>
          {command}
        </Code>
      </Box>
    </Box>
  );
}

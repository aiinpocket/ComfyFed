import {
  Accordion,
  Alert,
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
  IconServerOff,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api, peerReachable, type Role, type TokenBundle, type Worker } from '../api';
import { EmptyState, Mono, SectionHeader, TableSkeleton } from '../components/Primitives';
import { WorkerStatusBadge } from '../components/StatusBadge';
import { formatGb, formatRelative, shortId } from '../lib/format';
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

export function Workers({ role }: WorkersProps) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isAdmin = role === 'admin';

  const loader = useCallback(() => api.listWorkers(), []);
  const { data, loading, error, refresh } = usePolling(loader, POLL_MS);
  const workers = data ?? [];

  const [addOpen, setAddOpen] = useState(false);
  const [wheelUrl, setWheelUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .agentVersion()
      .then((v) => {
        if (!cancelled) setWheelUrl(v.wheel_url);
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
                  <Table.Th>{t('workers.col_p2p')}</Table.Th>
                  <Table.Th>{t('workers.col_last_seen')}</Table.Th>
                  {/* Wide enough for the disable + delete pair. Admin-only:
                      non-admins have no per-row actions, so no action column. */}
                  {isAdmin && <Table.Th w={210} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {workers.map((worker) => (
                  <Table.Tr key={worker.id} opacity={worker.disabled ? 0.55 : 1}>
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

import {
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
  IconX,
} from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api, type TokenBundle, type Worker } from '../api';
import { EmptyState, Mono, SectionHeader, TableSkeleton } from '../components/Primitives';
import { WorkerStatusBadge } from '../components/StatusBadge';
import { formatGb, formatRelative, shortId } from '../lib/format';
import { usePolling } from '../lib/usePolling';

const POLL_MS = 10000;

export function Workers() {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const loader = useCallback(() => api.listWorkers(), []);
  const { data, loading, error, refresh } = usePolling(loader, POLL_MS);
  const workers = data ?? [];

  const [addOpen, setAddOpen] = useState(false);
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

  return (
    <Stack gap="lg">
      <SectionHeader
        title={t('workers.title')}
        description={t('workers.subtitle')}
        action={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
            {t('workers.add')}
          </Button>
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
              <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
                {t('workers.add')}
              </Button>
            }
          />
        ) : (
          <Table.ScrollContainer minWidth={880}>
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
              <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                <Table.Tr>
                  <Table.Th>{t('workers.col_name')}</Table.Th>
                  <Table.Th>{t('workers.col_status')}</Table.Th>
                  <Table.Th>{t('workers.col_gpu')}</Table.Th>
                  <Table.Th>{t('workers.col_backend')}</Table.Th>
                  <Table.Th>{t('workers.col_models')}</Table.Th>
                  <Table.Th>{t('workers.col_last_seen')}</Table.Th>
                  <Table.Th w={110} />
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
                      <Text size="sm" c="dimmed">
                        {formatRelative(worker.last_seen, t)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
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
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

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
          <Group justify="space-between" gap="sm">
            <Button variant="default" onClick={close}>
              {t('common.done')}
            </Button>
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
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

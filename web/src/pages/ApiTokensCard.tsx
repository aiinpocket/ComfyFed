/**
 * Settings → 「API token / AI 存取」 card (API-token design §4.4).
 *
 * Its own file rather than another 250 lines inside `Settings.tsx` (already
 * ~700 lines): the card is self-contained, talks only to `/api/auth/tokens`,
 * and is rendered by the Settings page alongside the other cards.
 *
 * Two things here are deliberate and load-bearing:
 *  - The plaintext token exists ONLY in this component's state, only between
 *    `POST /api/auth/tokens` answering and the user dismissing the panel. It
 *    is never written into the token list, never re-fetchable, and is dropped
 *    on dismissal so no later render can bring it back.
 *  - The MCP config file is built client-side with a `Blob` (design §4.4):
 *    the server never sees a file, and the plaintext never makes a second
 *    round trip.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
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
  IconCheck,
  IconCopy,
  IconDownload,
  IconKey,
  IconPlus,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api, type ApiToken, type CreatedApiToken } from '../api';
import { Mono } from '../components/Primitives';
import { formatAbsolute } from '../lib/format';

/** Filename the console hands the user, and that the MCP server looks for at
 * `~/.comfyfed/mcp.json` (design §6.2). */
const CONFIG_FILENAME = 'comfyfed-mcp.json';

type TokenStatus = 'active' | 'revoked' | 'expired';

/** `active` is the server's own verdict; `revoked_at` is what separates a
 * revoked token from one that merely ran out of days. */
function tokenStatus(token: ApiToken): TokenStatus {
  if (token.revoked_at) return 'revoked';
  return token.active ? 'active' : 'expired';
}

const STATUS_COLOR: Record<TokenStatus, string> = {
  active: 'teal',
  revoked: 'red',
  expired: 'gray',
};

export function ApiTokensCard({ platformUrl }: { platformUrl: string }) {
  const { t } = useTranslation();
  const theme = useMantineTheme();

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** The one-time plaintext. Null except between a successful create and the
   * user dismissing the panel. */
  const [issued, setIssued] = useState<CreatedApiToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);
  const [revoking, setRevoking] = useState(false);

  const describe = useCallback(
    (caught: unknown) =>
      caught instanceof ApiError
        ? t(`errors.${caught.code}`, { defaultValue: caught.message })
        : t('errors.network'),
    [t],
  );

  const load = useCallback(
    async (notifyOnFailure = true) => {
      try {
        setTokens(await api.listTokens());
      } catch (caught) {
        if (notifyOnFailure) {
          notifications.show({
            color: 'red',
            icon: <IconX size={16} />,
            title: t('settings.tokens_load_failed'),
            message: describe(caught),
          });
        }
      }
    },
    [describe, t],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createToken(name.trim());
      setIssued(created);
      setName('');
      await load(false);
    } catch (caught) {
      setCreateError(describe(caught));
    } finally {
      setCreating(false);
    }
  };

  /** Build `comfyfed-mcp.json` in the browser and hand it to the download
   * manager. Nothing leaves the page: no request, no server-side copy. */
  const downloadConfig = () => {
    if (!issued) return;
    const payload = {
      platform_url: platformUrl,
      token: issued.token,
      expires_at: issued.expires_at,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = CONFIG_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api.revokeToken(revokeTarget.id);
      notifications.show({
        color: 'teal',
        icon: <IconCheck size={16} />,
        title: t('settings.token_revoked'),
        message: revokeTarget.name || revokeTarget.prefix,
      });
      setRevokeTarget(null);
      await load();
    } catch (caught) {
      notifications.show({
        color: 'red',
        icon: <IconX size={16} />,
        title: t('settings.token_revoke_failed'),
        message: describe(caught),
      });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Card
      style={{ background: theme.other.surfaces.card, borderColor: theme.other.surfaces.border }}
    >
      <Stack gap="sm">
        <Group gap="xs">
          <IconKey size={17} />
          <Text fw={600}>{t('settings.tokens_heading')}</Text>
        </Group>
        <Text size="sm" c="dimmed">
          {t('settings.tokens_hint')}
        </Text>

        <form onSubmit={create}>
          <Group align="flex-end" gap="sm" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              label={t('settings.token_name_label')}
              placeholder={t('settings.token_name_placeholder')}
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Button type="submit" leftSection={<IconPlus size={15} />} loading={creating}>
              {t('settings.token_create')}
            </Button>
          </Group>
        </form>

        {createError && (
          <Alert
            color="red"
            variant="light"
            p="sm"
            icon={<IconAlertTriangle size={16} />}
            title={t('settings.token_create_failed')}
          >
            <Text size="sm">{createError}</Text>
          </Alert>
        )}

        {issued && (
          <Alert color="teal" variant="light" title={t('settings.token_created')}>
            <Stack gap="xs">
              <Text size="sm">{t('settings.token_plaintext_warning')}</Text>
              <Group
                data-testid="api-token-plaintext"
                justify="space-between"
                gap="sm"
                p="xs"
                wrap="nowrap"
                style={{
                  background: theme.other.surfaces.raised,
                  border: `1px solid ${theme.other.surfaces.border}`,
                  borderRadius: theme.radius.md,
                }}
              >
                <Mono c="" size="sm" style={{ wordBreak: 'break-all' }}>
                  {issued.token}
                </Mono>
                <CopyButton value={issued.token} timeout={1500}>
                  {({ copied, copy }) => (
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color={copied ? 'teal' : 'gray'}
                      onClick={copy}
                      leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    >
                      {copied ? t('common.copied') : t('common.copy')}
                    </Button>
                  )}
                </CopyButton>
              </Group>
              <Text size="xs" c="dimmed">
                {t('settings.token_setup_hint')}
              </Text>
              <Group gap="sm" justify="flex-end">
                <Button variant="default" size="compact-sm" onClick={() => setIssued(null)}>
                  {t('settings.token_dismiss')}
                </Button>
                <Button
                  data-testid="api-token-download"
                  size="compact-sm"
                  leftSection={<IconDownload size={15} />}
                  onClick={downloadConfig}
                >
                  {t('settings.token_download')}
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}

        {tokens.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('settings.tokens_empty')}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="xs" horizontalSpacing="sm">
              <Table.Thead style={{ background: theme.other.surfaces.raised }}>
                <Table.Tr>
                  <Table.Th>{t('settings.token_col_name')}</Table.Th>
                  <Table.Th>{t('settings.token_col_prefix')}</Table.Th>
                  <Table.Th>{t('settings.token_col_created')}</Table.Th>
                  <Table.Th>{t('settings.token_col_expires')}</Table.Th>
                  <Table.Th>{t('settings.token_col_last_used')}</Table.Th>
                  <Table.Th>{t('settings.token_col_status')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {tokens.map((token) => {
                  const status = tokenStatus(token);
                  return (
                    <Table.Tr key={token.id}>
                      <Table.Td>
                        <Text size="sm" c={token.name ? undefined : 'dimmed'}>
                          {token.name || t('settings.token_unnamed')}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Mono size="xs" c="">
                          {token.prefix}
                        </Mono>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {formatAbsolute(token.created_at)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {formatAbsolute(token.expires_at)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {token.last_used_at ? formatAbsolute(token.last_used_at) : t('common.never')}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          variant="light"
                          color={STATUS_COLOR[status]}
                          tt="none"
                          fw={500}
                        >
                          {t(`settings.token_status_${status}`)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        {status === 'active' && (
                          <Tooltip label={t('settings.token_revoke')}>
                            <Button
                              data-testid={`api-token-revoke-${token.id}`}
                              size="compact-xs"
                              variant="light"
                              color="red"
                              leftSection={<IconTrash size={13} />}
                              onClick={() => setRevokeTarget(token)}
                            >
                              {t('settings.token_revoke')}
                            </Button>
                          </Tooltip>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>

      <Modal
        opened={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={t('settings.token_revoke_title')}
      >
        <Stack gap="md">
          <Text size="sm">
            {t('settings.token_revoke_confirm', {
              name: revokeTarget?.name || revokeTarget?.prefix || '',
            })}
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setRevokeTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button color="red" loading={revoking} onClick={() => void confirmRevoke()}>
              {t('settings.token_revoke')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

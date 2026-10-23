import { Ionicons } from '@expo/vector-icons';
import type { ChatItem } from '@pocket/client-core';
import { DEFAULT_SCREEN_WATCH_SETTINGS, type PermissionDecision, type ScreenWatchSettings } from '@pocket/protocol';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../../src/components/Avatar';
import { ChatRow } from '../../src/components/ChatRow';
import { ClaudeAvatar } from '../../src/components/ClaudeAvatar';
import { ClaudeComposer, type ComposerActions } from '../../src/components/ClaudeComposer';
import { Composer } from '../../src/components/Composer';
import { PermissionCard } from '../../src/components/PermissionCard';
import { TypingBubble } from '../../src/components/TypingBubble';
import { makeConversations, type FakeConversation } from '../../src/content/fake';
import { isActiveNow } from '../../src/direct';
import { personaFor } from '../../src/persona';
import { useChatSelector, useSession } from '../../src/session';
import { markOpened } from '../../src/state/unread';
import { colors, ownBubble, radius } from '../../src/theme';

const EMPTY: ChatItem[] = [];

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

function ThreadHeader({
  avatar,
  title,
  subtitle,
  subtitleColor,
  onCall,
  onVideo,
  onWatch,
  watching = false,
  watchDisabled = false,
  onSubtitle,
}: {
  avatar: ReactNode;
  title: string;
  subtitle: string;
  subtitleColor?: string;
  onCall?: () => void;
  onVideo?: () => void;
  onWatch?: () => void;
  watching?: boolean;
  watchDisabled?: boolean;
  /** The status line names the computer; tapping it opens the computer picker. */
  onSubtitle?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View style={[styles.header, { paddingTop: insets.top, height: 56 + insets.top }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={26} color={colors.text} />
      </Pressable>
      {avatar}
      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Pressable onPress={onSubtitle} hitSlop={6}>
          <Text style={[styles.subtitle, subtitleColor ? { color: subtitleColor } : null]} numberOfLines={1}>
            {subtitle}
          </Text>
        </Pressable>
      </View>
      <Pressable onPress={onCall} disabled={!onCall} hitSlop={10} accessibilityLabel="Computers">
        <Ionicons name="call-outline" size={24} color={colors.text} />
      </Pressable>
      <Pressable onPress={onVideo} disabled={!onVideo} hitSlop={10} accessibilityLabel="Activity">
        <Ionicons name="videocam-outline" size={27} color={colors.text} />
      </Pressable>
      <Pressable
        onPress={onWatch}
        disabled={!onWatch || watchDisabled}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={watching ? 'Перестать смотреть экран' : 'Смотреть экран'}
      >
        <Ionicons name={watching ? 'eye' : 'eye-outline'} size={25} color={watching ? colors.accent : watchDisabled ? colors.textMuted : colors.text} />
      </Pressable>
    </View>
  );
}

function ClaudeThread({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { client } = useSession();
  // Field by field: a chat must not re-render for every word streamed into another chat.
  const session = useChatSelector((s) => s.sessions.find((x) => x.sessionId === id));
  const thread = useChatSelector((s) => s.threads[id]) ?? EMPTY;
  const loaded = useChatSelector((s) => s.loaded[id] === true);
  const allPermissions = useChatSelector((s) => s.permissions);
  const connection = useChatSelector((s) => s.connection);
  const brainOnline = useChatSelector((s) => s.brainOnline);
  const models = useChatSelector((s) => s.models);
  const computers = useChatSelector((s) => s.computers);
  const activeComputer = useChatSelector((s) => s.activeComputer);
  const keyboardVisible = useKeyboardVisible();
  const [watchSettingsOpen, setWatchSettingsOpen] = useState(false);
  const [watchDraft, setWatchDraft] = useState<ScreenWatchSettings>({ ...DEFAULT_SCREEN_WATCH_SETTINGS });

  const permissions = useMemo(() => allPermissions.filter((p) => p.sessionId === id), [allPermissions, id]);
  const persona = useMemo(() => personaFor(id), [id]);
  const data = useMemo(
    () => thread.filter((item) => !(item.type === 'user' && item.observation) && !(item.type === 'assistant' && item.observation && item.streaming) && !(item.type === 'result' && item.observation)).reverse(),
    [thread],
  );
  const running = session?.state === 'running' || session?.state === 'waiting_permission';
  const updatedAt = session?.updatedAt ?? 0;

  useEffect(() => {
    markOpened(id);
    return () => markOpened(id);
  }, [id]);

  useEffect(() => {
    if (updatedAt > 0) markOpened(id);
  }, [id, updatedAt]);

  useEffect(() => {
    if (client && !loaded && connection === 'online') client.loadHistory(id);
  }, [client, id, loaded, connection]);

  useEffect(() => {
    if (client && connection === 'online' && brainOnline && models.length === 0) client.loadModels();
  }, [client, connection, brainOnline, models.length]);

  const watchSettings = session?.watch?.settings ?? DEFAULT_SCREEN_WATCH_SETTINGS;
  const watching = session?.watch?.state === 'watching' || session?.watch?.state === 'paused';
  const canWatch = client?.canWatchScreen(id) ?? false;
  const watchComputerId = session?.executorId ?? activeComputer;
  const watchComputer = computers.find((c) => c.deviceId === watchComputerId);
  const watchLine = session?.watch?.state === 'watching' ? '👁 Claude смотрит экран' : session?.watch?.state === 'paused' ? '👁 Наблюдение приостановлено' : null;

  useEffect(() => {
    if (!watchSettingsOpen) setWatchDraft({ ...watchSettings });
  }, [id, watchSettings, watchSettingsOpen]);

  const openWatchSettings = () => {
    setWatchDraft({ ...watchSettings });
    setWatchSettingsOpen(true);
  };

  const toggleWatch = () => {
    client?.setScreenWatch(id, !watching, !watching ? { settings: watchSettings } : {});
  };

  const adjustWatchSetting = (key: 'intervalMs' | 'maxPerMinute' | 'maxPerHour' | 'retainFrames', delta: number, min: number, max: number) => {
    setWatchDraft((current) => ({ ...current, [key]: Math.max(min, Math.min(max, current[key] + delta)) }));
  };

  const saveWatchSettings = () => {
    if (!client?.setScreenWatch(id, watching, { settings: watchDraft })) return;
    setWatchSettingsOpen(false);
  };

  const actions = useMemo<ComposerActions>(
    () => ({
      send: (text, attachments) => client?.send(id, text, attachments.map(({ mime, dataBase64, name }) => ({ mime, dataBase64, ...(name ? { name } : {}) }))) ?? false,
      stop: () => void client?.interrupt(id),
      configure: (patch) => void client?.configure(id, patch),
      newChat: () => {
        client
          ?.createSession()
          .then((next) => router.replace({ pathname: '/direct/[id]', params: { id: next } }))
          .catch(() => {});
      },
      agents: () => router.push('/direct/activity'),
      kill: () => void client?.kill(),
    }),
    [client, id, router],
  );

  const respond = useCallback(
    (requestId: string, decision: PermissionDecision) => {
      client?.respondPermission(requestId, decision);
    },
    [client],
  );

  const last = thread[thread.length - 1];
  const working = session?.state === 'running' && !(last?.type === 'assistant' && last.streaming);
  const computer = useMemo(
    () => computers.find((c) => c.deviceId === session?.executorId && (!c.capabilities || c.capabilities.includes('tools'))),
    [session?.executorId, computers],
  );
  const macOnline = connection === 'online' && brainOnline;
  const projectName = session?.project?.split(/[\\/]/).filter(Boolean).pop();
  const active = macOnline && (computer ? computer.online : true);
  const status = !session
    ? ''
    : session.state === 'running'
      ? 'Typing…'
      : session.state === 'waiting_permission'
        ? 'Waiting for approval'
        : !macOnline
          ? 'Mac offline'
          : !computer
            ? `Active now · Mac${projectName ? ` · ${projectName}` : ''}`
            : computer.online
              ? `Active now · ${computer.name}${projectName ? ` · ${projectName}` : ''}`
              : `${computer.name} offline`;
  const headerStatus = watchLine ? `${watchLine}${status ? ` · ${status}` : ''}` : status;

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      <ThreadHeader
        avatar={<ClaudeAvatar size={36} active={active} persona={persona} />}
        title={persona.name}
        subtitle={headerStatus}
        subtitleColor={session?.state === 'waiting_permission' ? colors.warn : undefined}
        onCall={() => router.push({ pathname: '/direct/call', params: { id } })}
        onVideo={actions.agents}
        onWatch={toggleWatch}
        watching={watching}
        watchDisabled={!watching && !canWatch}
        onSubtitle={() => router.push({ pathname: '/direct/computers', params: { sessionId: id } })}
      />

      {watching || canWatch ? (
        <View style={styles.watchBar}>
          <Text style={styles.watchBarText} numberOfLines={1}>
            {watchLine ?? `👁 Наблюдение выключено · ${watchComputer?.name ?? 'ПК'}`}
          </Text>
          <Pressable onPress={openWatchSettings} hitSlop={8} accessibilityRole="button" accessibilityLabel="Настройки наблюдения">
            <Ionicons name="settings-outline" size={20} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}

      <FlatList
        data={data}
        inverted
        keyExtractor={(it) => it.key}
        renderItem={({ item }) => <ChatRow item={item} persona={persona} />}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        ListHeaderComponent={working ? <TypingBubble persona={persona} /> : undefined}
        ListEmptyComponent={
          loaded ? (
            <View style={[styles.empty, { transform: [{ scaleY: -1 }] }]}>
              <ClaudeAvatar size={72} persona={persona} />
              <Text style={styles.emptyName}>{persona.name}</Text>
              <Text style={styles.emptyText}>Type / to pick a model, reasoning level and more.</Text>
            </View>
          ) : (
            <View style={[styles.empty, { transform: [{ scaleY: -1 }] }]}>
              <ActivityIndicator color={colors.text} />
            </View>
          )
        }
      />

      <View style={[styles.bottom, { paddingBottom: keyboardVisible ? 8 : insets.bottom + 8 }]}> 
        {permissions.map((p) => (
          <PermissionCard key={p.requestId} request={p} onRespond={respond} />
        ))}
        <ClaudeComposer running={running} session={session} models={models} actions={actions} />
      </View>

      <Modal visible={watchSettingsOpen} transparent animationType="fade" onRequestClose={() => setWatchSettingsOpen(false)}>
        <View style={styles.watchModal}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setWatchSettingsOpen(false)} accessibilityLabel="Закрыть настройки" />
          <View style={styles.watchSettingsCard}>
            <Text style={styles.watchSettingsTitle}>Настройки наблюдения</Text>
            <WatchSettingRow
              label="Интервал"
              value={watchDraft.intervalMs}
              display={`${(watchDraft.intervalMs / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} с`}
              step={250}
              min={500}
              max={3000}
              onChange={(delta) => adjustWatchSetting('intervalMs', delta, 500, 3000)}
            />
            <WatchSettingRow
              label="Лимит в минуту"
              value={watchDraft.maxPerMinute}
              step={1}
              min={1}
              max={4}
              onChange={(delta) => adjustWatchSetting('maxPerMinute', delta, 1, 4)}
            />
            <WatchSettingRow
              label="Лимит в час"
              value={watchDraft.maxPerHour}
              step={1}
              min={1}
              max={60}
              onChange={(delta) => adjustWatchSetting('maxPerHour', delta, 1, 60)}
            />
            <WatchSettingRow
              label="Кадров в истории"
              value={watchDraft.retainFrames}
              step={1}
              min={1}
              max={10}
              onChange={(delta) => adjustWatchSetting('retainFrames', delta, 1, 10)}
            />
            <View style={styles.watchSettingsActions}>
              <Pressable onPress={() => setWatchSettingsOpen(false)} accessibilityRole="button">
                <Text style={styles.watchCancel}>Отмена</Text>
              </Pressable>
              <Pressable onPress={saveWatchSettings} accessibilityRole="button">
                <Text style={styles.watchSave}>Сохранить</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function WatchSettingRow({
  label,
  value,
  display = String(value),
  step,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  display?: string;
  step: number;
  min: number;
  max: number;
  onChange: (delta: number) => void;
}) {
  return (
    <View style={styles.watchSettingRow}>
      <Text style={styles.watchSettingLabel}>{label}</Text>
      <View style={styles.watchStepper}>
        <Pressable onPress={() => onChange(-step)} disabled={value <= min} style={styles.watchStepButton} accessibilityLabel={`Уменьшить: ${label}`}>
          <Text style={styles.watchStepText}>−</Text>
        </Pressable>
        <Text style={styles.watchValue}>{display}</Text>
        <Pressable onPress={() => onChange(step)} disabled={value >= max} style={styles.watchStepButton} accessibilityLabel={`Увеличить: ${label}`}>
          <Text style={styles.watchStepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function FakeThread({ conversation }: { conversation: FakeConversation }) {
  const insets = useSafeAreaInsets();
  const data = useMemo(() => [...conversation.messages].reverse(), [conversation]);
  return (
    <View style={styles.root}>
      <ThreadHeader
        avatar={<Avatar uri={conversation.person.avatar} size={36} />}
        title={conversation.person.username}
        subtitle={conversation.active ? 'Active now' : conversation.name}
      />
      <FlatList
        data={data}
        inverted
        keyExtractor={(m) => m.id}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.list}
        renderItem={({ item }) =>
          item.mine ? (
            <View style={styles.mineWrap}>
              <LinearGradient colors={ownBubble} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.bubble}>
                <Text style={styles.mineText}>{item.text}</Text>
              </LinearGradient>
            </View>
          ) : (
            <View style={styles.theirsWrap}>
              <Avatar uri={conversation.person.avatar} size={28} />
              <View style={[styles.bubble, styles.theirsBubble]}>
                <Text style={styles.mineText}>{item.text}</Text>
              </View>
            </View>
          )
        }
      />
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 8 }]}>
        <Composer readOnly />
      </View>
    </View>
  );
}

export default function DirectThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversation = useMemo(() => (id.startsWith('fake-') ? makeConversations().find((c) => c.id === id) : undefined), [id]);
  return conversation ? <FakeThread conversation={conversation} /> : <ClaudeThread id={id} />;
}

function Separator() {
  return <View style={{ height: 6 }} />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 12 },
  headerText: { flex: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  list: { paddingHorizontal: 12, paddingVertical: 12, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  emptyName: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 4 },
  emptyText: { color: colors.textMuted, textAlign: 'center', fontSize: 14, lineHeight: 20 },
  bottom: { paddingHorizontal: 12, paddingTop: 6, gap: 8 },
  mineWrap: { alignItems: 'flex-end', paddingLeft: 64 },
  theirsWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingRight: 64 },
  bubble: { borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10 },
  theirsBubble: { backgroundColor: colors.bubble, flexShrink: 1 },
  mineText: { color: colors.userText, fontSize: 15, lineHeight: 21 },
});

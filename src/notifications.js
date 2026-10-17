import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export const alertsSupported = Capacitor.isNativePlatform();
const CHANNEL = 'airing';
const ACTION_TYPE = 'EPISODE';
const WEEK = 7 * 24 * 3600;
const AHEAD = 4; // schedule this many upcoming episodes per show
const MAX_PENDING = 60;

/** Ask for notification permission (Android 13+). Returns true if granted. */
export const ensurePermission = async () => {
  if (!alertsSupported) return false;
  let p = await LocalNotifications.checkPermissions();
  if (p.display === 'prompt' || p.display === 'prompt-with-rationale') {
    p = await LocalNotifications.requestPermissions();
  }
  return p.display === 'granted';
};

/**
 * Re-create airing alerts from the watchlist. Only shows you are WATCHING get alerts.
 * Later episodes are estimated weekly from the next known air time; the app corrects
 * them every time it syncs with AniList.
 */
export const scheduleAiring = async (watchlist, enabled) => {
  if (!alertsSupported) return;
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) {
    await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
  }
  if (!enabled) return;
  if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;

  await LocalNotifications.createChannel({
    id: CHANNEL, name: 'New episodes', description: 'Alerts when episodes you follow air', importance: 4
  });

  await LocalNotifications.registerActionTypes({
    types: [{ id: ACTION_TYPE, actions: [{ id: 'WATCHED', title: 'Mark watched' }] }]
  });

  const now = Math.floor(Date.now() / 1000);
  const notifications = [];
  for (const a of watchlist) {
    if (a.status !== 'WATCHING' || !a.nextEpisodeAt || a.airedEpisodes == null) continue;
    const name = a.title?.english || a.title?.romaji || 'An anime';
    for (let k = 0; k < AHEAD; k++) {
      const at = a.nextEpisodeAt + k * WEEK;
      const ep = a.airedEpisodes + 1 + k;
      if (at <= now || (a.totalEpisodes && ep > a.totalEpisodes)) continue;
      notifications.push({
        id: a.id * 10 + k,
        title: name,
        body: `Episode ${ep} is out now`,
        schedule: { at: new Date(at * 1000), allowWhileIdle: true },
        channelId: CHANNEL,
        actionTypeId: ACTION_TYPE,
        extra: { animeId: a.id, episode: ep }
      });
    }
  }
  notifications.sort((x, y) => x.schedule.at - y.schedule.at);
  if (notifications.length) await LocalNotifications.schedule({ notifications: notifications.slice(0, MAX_PENDING) });
};

/** Calls cb(animeId, episode) when the user taps "Mark watched" on an alert. Returns an unsubscribe function. */
export const onWatchedAction = async (cb) => {
  if (!alertsSupported) return () => {};
  const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const x = e.notification?.extra;
    if (e.actionId === 'WATCHED' && x?.animeId) cb(Number(x.animeId), Number(x.episode));
  });
  return () => handle.remove();
};

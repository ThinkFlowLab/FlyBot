export function actionFollowupChannel(view) {
  try {
    return typeof view?.BroadcastChannel === 'function' ? new view.BroadcastChannel('flybot-workspace:memory-action-followups') : null;
  } catch { return null; }
}

export function notifyActionFollowup(view, workspace, action) {
  if (!action) return;
  const channel = actionFollowupChannel(view);
  if (!channel) return;
  try { channel.postMessage({workspace, action}); }
  finally { channel.close(); }
}

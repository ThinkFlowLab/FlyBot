// Shared Personal Agent look avatar. The server stores one of these looks in
// onboarding step 4; this module renders it with plain DOM nodes and CSS, not
// user-supplied markup. Values are an explicit allowlist so a corrupt stored
// row cannot inject arbitrary attributes or text.

export const LOOK_FIELDS = ['color', 'expression', 'headwear', 'glasses', 'hand'];

export const LOOK_OPTIONS = {
  color: ['珊瑚橙', '天空蓝', '薄荷绿', '葡萄紫', '柠檬黄', '石墨灰'],
  expression: ['微笑', '专注', '好奇', '酷'],
  headwear: ['无', '棒球帽', '耳机', '贝雷帽'],
  glasses: ['无', '圆框眼镜', '墨镜'],
  hand: ['无', '咖啡杯', '笔记本', '魔法棒'],
};

export function validLook(look) {
  if (!look || typeof look !== 'object' || Array.isArray(look)) return false;
  return LOOK_FIELDS.every((name) => LOOK_OPTIONS[name].includes(look[name]));
}

export function createLookAvatar(look, document) {
  if (!document || !validLook(look)) return null;
  const root = document.createElement('span');
  root.className = 'look-avatar';
  root.setAttribute('aria-hidden', 'true');
  for (const name of LOOK_FIELDS) root.dataset[name] = look[name];
  for (const classes of ['look-portrait', 'look-glasses', 'look-hand']) {
    const node = document.createElement('span');
    node.className = classes;
    root.append(node);
  }
  return root;
}

export const AGENT_PORTRAITS = Object.freeze([
  {id:'sky', label:'天空蓝', color:'天空蓝', expression:'微笑', headwear:'无'},
  {id:'mint', label:'薄荷绿', color:'薄荷绿', expression:'专注', headwear:'耳机'},
  {id:'violet', label:'葡萄紫', color:'葡萄紫', expression:'好奇', headwear:'贝雷帽'},
  {id:'coral', label:'珊瑚橙', color:'珊瑚橙', expression:'微笑', headwear:'棒球帽'},
  {id:'amber', label:'柠檬黄', color:'柠檬黄', expression:'好奇', headwear:'无'},
  {id:'graphite', label:'石墨灰', color:'石墨灰', expression:'酷', headwear:'耳机'},
]);

export function agentPortraitLook(id, selected, personalLook) {
  const chosen = AGENT_PORTRAITS.find(preset => preset.id === selected);
  if (!chosen && validLook(personalLook)) return personalLook;
  if (!chosen && (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id))) return null;
  const preset = chosen || AGENT_PORTRAITS[Number.parseInt(id.slice(-2),16) % AGENT_PORTRAITS.length];
  return {color:preset.color, expression:preset.expression, headwear:preset.headwear, glasses:'无', hand:'无'};
}

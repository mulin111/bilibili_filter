'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const core = require('../bili-feed-filter.user.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('md5 matches Node crypto for ASCII and Chinese', () => {
  const samples = ['', 'abc', 'hello world', '中文', 'B站推荐流'];
  for (const sample of samples) {
    const expected = crypto.createHash('md5').update(sample, 'utf8').digest('hex');
    assert.equal(core.md5(sample), expected, sample);
  }
});

test('App API URL is stable and signed over sorted params', () => {
  const url = core.buildAppApiUrl('25876945', { ts: 1793113073, pn: 1, ps: 20 });
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://app.bilibili.com');
  assert.equal(parsed.pathname, '/x/v2/space/archive');
  assert.equal(parsed.searchParams.get('vmid'), '25876945');
  assert.equal(parsed.searchParams.get('pn'), '1');
  assert.equal(parsed.searchParams.get('ps'), '20');
  assert.equal(parsed.searchParams.get('ts'), '1793113073');
  assert.equal(parsed.searchParams.get('order'), 'pubdate');

  const params = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    if (key !== 'sign') params[key] = value;
  }
  const query = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
  const expected = crypto.createHash('md5').update(query + '560c52ccd288fed045859ed18bffd973', 'utf8').digest('hex');
  assert.equal(parsed.searchParams.get('sign'), expected);
});

test('extractMidFromHref handles space URLs', () => {
  assert.equal(core.extractMidFromHref('//space.bilibili.com/25876945/'), '25876945');
  assert.equal(core.extractMidFromHref('https://space.bilibili.com/123?spm_id_from=333.1'), '123');
  assert.equal(core.extractMidFromHref('https://www.bilibili.com/video/BV1xx'), '');
  assert.equal(core.extractMidFromHref(''), '');
});

test('extractBvidFromHref handles relative and absolute links', () => {
  assert.equal(core.extractBvidFromHref('/video/BV1kMxM6FECM/?spm_id_from=333.788'), 'BV1kMxM6FECM');
  assert.equal(core.extractBvidFromHref('https://www.bilibili.com/video/BV1abcXYZ'), 'BV1abcXYZ');
  assert.equal(core.extractBvidFromHref('https://space.bilibili.com/1'), '');
});

test('parsePlayCount parses abbreviations and labels', () => {
  assert.equal(core.parsePlayCount('1234'), 1234);
  assert.equal(core.parsePlayCount('1,234'), 1234);
  assert.equal(core.parsePlayCount('2.8万'), 28000);
  assert.equal(core.parsePlayCount('1.2亿'), 120000000);
  assert.equal(core.parsePlayCount('10万+'), 100000);
  assert.equal(core.parsePlayCount('播放 2.8万'), 28000);
  assert.equal(core.parsePlayCount('2.8万 1234'), 28000);
  assert.equal(core.parsePlayCount('01:23 456'), null);
  assert.equal(core.parsePlayCount(''), null);
  assert.equal(core.parsePlayCount('暂无'), null);
});

test('isFollowedText only treats real followed labels as followed', () => {
  assert.equal(core.isFollowedText('已关注'), true);
  assert.equal(core.isFollowedText(' Following '), true);
  assert.equal(core.isFollowedText('12万点赞'), false);
  assert.equal(core.isFollowedText('关注'), false);
  assert.equal(core.isFollowedText(''), false);
});

test('countInWindow includes the boundary and ignores future values', () => {
  const now = 1000000;
  const window = 24 * 3600;
  const timestamps = [now - window, now - window - 1, now - 10, now + 100, now + 301];
  assert.equal(core.countInWindow(timestamps, now, window), 3);
});

test('maxInAnyWindow finds the densest window', () => {
  const now = 1000000;
  const day = 86400;
  const timestamps = [
    now - 10 * day,
    now - 9 * day,
    now - 8 * day,
    now - 2 * day,
    now - 2 * day + 100,
    now - 2 * day + 200,
    now - day
  ];
  assert.equal(core.maxInAnyWindow(timestamps, now, 7 * day, day), 4);
  assert.equal(core.maxInAnyWindow(timestamps, now, 7 * day, day - 1), 3);
  assert.equal(core.maxInAnyWindow([], now, 7 * day, day), 0);
});

test('evaluateMassUpload handles current window and live replay exclusion', () => {
  const now = 1793113000000;
  const rule = core.makeDefaultRules()[0];
  const day = 86400;
  const videos = [
    { ctime: now / 1000 - 10, live: false },
    { ctime: now / 1000 - 20, live: false },
    { ctime: now / 1000 - 30, live: true },
    { ctime: now / 1000 - 40, live: false },
    { ctime: now / 1000 - day - 1, live: false }
  ];
  const result = core.evaluateMassUpload(rule, videos, now);
  assert.equal(result.count, 3);
  assert.equal(result.blocked, false);

  const strict = clone(rule);
  strict.config.threshold = 3;
  assert.equal(core.evaluateMassUpload(strict, videos, now).blocked, true);

  const withLive = clone(rule);
  withLive.config.excludeLiveReplay = false;
  assert.equal(core.evaluateMassUpload(withLive, videos, now).count, 4);
});

test('evaluateMassUpload rolling mode catches a recent burst', () => {
  const now = 1793113000000;
  const rule = clone(core.makeDefaultRules()[0]);
  rule.config.rolling = true;
  rule.config.threshold = 3;
  rule.config.windowHours = 6;
  rule.config.lookbackDays = 7;
  const day = 86400;
  const base = now / 1000;
  const videos = [
    { ctime: base - 2 * day, live: false },
    { ctime: base - 2 * day + 600, live: false },
    { ctime: base - 2 * day + 1200, live: false },
    { ctime: base - 2 * day + 1800, live: false },
    { ctime: base - day, live: false }
  ];
  const result = core.evaluateMassUpload(rule, videos, now);
  assert.equal(result.count, 4);
  assert.equal(result.blocked, true);
  assert.match(result.reason, /最近 7 天内/);
});

test('default rules validate', () => {
  const result = core.validateRules(core.makeDefaultRules());
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.rules.length, 6);
});

test('validateRules rejects duplicate ids and unknown types', () => {
  const rules = clone(core.makeDefaultRules());
  rules[1].id = 'mass-upload';
  let result = core.validateRules(rules);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('重复')));

  const unknown = clone(core.makeDefaultRules());
  unknown[0].type = 'custom-script';
  result = core.validateRules(unknown);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('不支持')));
});

test('validateRules checks keyword, regex, mass and play-count constraints', () => {
  const keyword = clone(core.makeDefaultRules());
  keyword[3].enabled = true;
  keyword[3].config.keywords = [];
  assert.equal(core.validateRules(keyword).ok, false);

  const regex = clone(core.makeDefaultRules());
  regex[3].enabled = true;
  regex[3].config.regex = true;
  regex[3].config.keywords = ['('];
  assert.equal(core.validateRules(regex).ok, false);

  const massAllow = clone(core.makeDefaultRules());
  massAllow[0].action = 'allow';
  assert.equal(core.validateRules(massAllow).ok, false);

  const rolling = clone(core.makeDefaultRules());
  rolling[0].config.rolling = true;
  rolling[0].config.windowHours = 48;
  rolling[0].config.lookbackDays = 1;
  assert.equal(core.validateRules(rolling).ok, false);

  const play = clone(core.makeDefaultRules());
  play[4].config.min = 5000;
  play[4].config.max = 1000;
  assert.equal(core.validateRules(play).ok, false);

  const uid = clone(core.makeDefaultRules());
  uid[1].config.uids = ['not-a-uid'];
  assert.equal(core.validateRules(uid).ok, false);
});

test('validateRules normalizes UID and name lists', () => {
  const rules = clone(core.makeDefaultRules());
  rules[1].config.uids = [123, '123', '456'];
  rules[1].config.names = [' 极客湾 ', '极客湾', ''];
  const result = core.validateRules(rules);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.rules[1].config.uids, ['123', '456']);
  assert.deepEqual(result.rules[1].config.names, ['极客湾']);
});

test('allow UID list overrides keyword block', () => {
  const rules = clone(core.makeDefaultRules());
  rules[1].config.uids = ['123'];
  rules[3].enabled = true;
  rules[3].config.keywords = ['营销号'];
  rules[3].config.matchTitle = true;
  const card = {
    page: 'home',
    mid: '123',
    upName: '某个 UP',
    title: '营销号标题',
    playCount: 100
  };
  const result = core.evaluateStaticRules(card, rules, 'home');
  assert.equal(result.decision, 'allow');
});

test('keyword, UID list and play-count rules block as expected', () => {
  const rules = clone(core.makeDefaultRules());
  rules[3].enabled = true;
  rules[3].config.keywords = ['标题党', 'bad'];
  rules[3].config.matchTitle = true;
  rules[3].config.matchUpName = false;
  const keywordResult = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '这是一个标题党视频', playCount: 10000 },
    rules,
    'home'
  );
  assert.equal(keywordResult.decision, 'block');
  assert.match(keywordResult.reason, /标题党/);

  const blacklist = clone(core.makeDefaultRules());
  blacklist[2].enabled = true;
  blacklist[2].config.uids = ['999'];
  const uidResult = core.evaluateStaticRules(
    { page: 'video', mid: '999', upName: 'UP', title: '标题', playCount: 1 },
    blacklist,
    'video'
  );
  assert.equal(uidResult.decision, 'block');

  const lowPlay = clone(core.makeDefaultRules());
  lowPlay[4].enabled = true;
  lowPlay[4].config.min = 0;
  lowPlay[4].config.max = 1000;
  const playResult = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '标题', playCount: 800 },
    lowPlay,
    'home'
  );
  assert.equal(playResult.decision, 'block');
  assert.match(playResult.reason, /800/);

  const missingPlay = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '标题', playCount: null },
    lowPlay,
    'home'
  );
  assert.equal(missingPlay.decision, 'none');
});

test('rules respect scope, enabled and action', () => {
  const rules = clone(core.makeDefaultRules());
  rules[3].enabled = true;
  rules[3].scope = ['video'];
  rules[3].config.keywords = ['标题党'];
  const home = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '标题党', playCount: 1 },
    rules,
    'home'
  );
  assert.equal(home.decision, 'none');
  const video = core.evaluateStaticRules(
    { page: 'video', mid: '1', upName: 'UP', title: '标题党', playCount: 1 },
    rules,
    'video'
  );
  assert.equal(video.decision, 'block');

  const disabled = clone(core.makeDefaultRules());
  disabled[3].enabled = false;
  disabled[3].config.keywords = ['标题党'];
  assert.equal(
    core.evaluateStaticRules(
      { page: 'home', mid: '1', upName: 'UP', title: '标题党', playCount: 1 },
      disabled,
      'home'
    ).decision,
    'none'
  );

  const allowKeyword = clone(core.makeDefaultRules());
  allowKeyword[3].enabled = true;
  allowKeyword[3].action = 'allow';
  allowKeyword[3].config.keywords = ['官方'];
  const allowed = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '官方发布', playCount: 1 },
    allowKeyword,
    'home'
  );
  assert.equal(allowed.decision, 'allow');
});

test('mass-upload rule is not applied by the static evaluator', () => {
  const rules = clone(core.makeDefaultRules());
  const result = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '普通标题', playCount: 1 },
    rules,
    'home'
  );
  assert.equal(result.decision, 'none');
});

test('ruleAppliesToPage defaults to both pages', () => {
  assert.equal(core.ruleAppliesToPage({ scope: ['home'] }, 'home'), true);
  assert.equal(core.ruleAppliesToPage({ scope: ['home'] }, 'video'), false);
  assert.equal(core.ruleAppliesToPage({}, 'video'), true);
});

test('custom reason is used by static and mass rules', () => {
  const keywordRules = clone(core.makeDefaultRules());
  keywordRules[3].enabled = true;
  keywordRules[3].reason = '自定义关键词原因';
  keywordRules[3].config.keywords = ['标题党'];
  const keywordResult = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '标题党', playCount: 1 },
    keywordRules,
    'home'
  );
  assert.equal(keywordResult.reason, '自定义关键词原因');

  const massRule = clone(core.makeDefaultRules()[0]);
  massRule.reason = '自定义高频原因';
  const massResult = core.evaluateMassUpload(
    massRule,
    [{ ctime: Math.floor(Date.now() / 1000), live: false }],
    Date.now()
  );
  assert.equal(massResult.reason, '自定义高频原因');
  assert.equal(massResult.shortReason, '自定义高频原因');
});

test('default settings enable conservative mass feedback', () => {
  const settings = core.makeDefaultSettings();
  assert.equal(settings.autoDislike, 'mass');
  assert.equal(settings.dislikeReason, 4);
});

test('allow keyword overrides block keyword', () => {
  const rules = clone(core.makeDefaultRules());
  const blockKeyword = rules.find((rule) => rule.id === 'keywords');
  const allowKeyword = rules.find((rule) => rule.id === 'keywords-allow');
  blockKeyword.enabled = true;
  blockKeyword.config.keywords = ['营销号'];
  allowKeyword.enabled = true;
  allowKeyword.config.keywords = ['官方'];
  allowKeyword.config.matchTitle = true;
  const result = core.evaluateStaticRules(
    { page: 'home', mid: '1', upName: 'UP', title: '官方发布会 营销号', playCount: 100 },
    rules,
    'home'
  );
  assert.equal(result.decision, 'allow');
  assert.equal(result.rule.id, 'keywords-allow');
});


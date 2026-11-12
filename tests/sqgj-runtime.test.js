'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../SQGJ 自动连播.user.js'), 'utf8');

// Run the actual userscript controller, with a deterministic clock and the DOM
// selectors observed on the live study page. No network or learning records.
function studyFixture({ completed = false, resetOnEnded = false, closeAllowed = true,
  stalePlayOverlay = false } = {}) {
  let now = 100_000;
  let nextTimer = 0;
  const timers = new Map();
  const capture = new Map();
  const logs = [];
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    };
  };
  const player = new EventTarget();
  Object.assign(player, {
    currentSrc: 'https://media.example/one.m3u8', currentTime: 10, duration: 100,
    ended: false, paused: false, readyState: 4, dataset: {}, muted: true, volume: 0,
    getAttribute: () => null,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  if (resetOnEnded) {
    player.addEventListener('ended', () => {
      player.currentTime = 0;
      player.ended = false;
      player.paused = true;
    });
  }
  const lessons = [0, 1].map((index) => {
    const progress = {
      value: completed ? 100 : 0,
      matches: (selector) => selector.includes('[aria-valuenow]'),
      getAttribute(name) { return name === 'aria-valuenow' ? String(this.value) : null; },
    };
    const title = {
      textContent: `《测试课程（${index ? '下' : '上'}）》`,
      getAttribute: () => null,
      click() {
        lessons.forEach((lesson) => { lesson.active = lesson.index === index; });
        player.currentSrc = `https://media.example/${index ? 'two' : 'one'}.m3u8`;
        player.currentTime = 0;
        player.ended = false;
        player.paused = true;
      },
    };
    return {
      index, active: index === 0, progress, title, dataset: { id: `lesson-${index}` },
      textContent: title.textContent,
      matches(selector) { return selector.includes('.accc') && this.active; },
      querySelector(selector) {
        if (selector === '.vvitemtitle') return title;
        if (selector.includes('.vvitemtitle.accc')) return this.active ? title : null;
        return null;
      },
      querySelectorAll: () => [progress],
    };
  });
  const centerPlay = {
    className: 'd-play-btn', getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 60, height: 60 }),
  };
  const toolbar = {
    clicks: 0, textContent: '', className: 'd-tool-item',
    getAttribute: () => null, querySelector: () => null,
    click() { this.clicks++; player.paused = !player.paused; },
  };
  const doc = new EventTarget();
  const nativeListen = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, options) => {
    if (options === true || options?.capture) {
      const listeners = capture.get(type) || [];
      listeners.push(fn);
      capture.set(type, listeners);
    } else nativeListen(type, fn, options);
  };
  const playlist = {};
  Object.assign(doc, {
    referrer: 'https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail?installId=2026',
    hidden: false, body: { textContent: '年度网络自学课程' }, documentElement: {},
    getElementById: () => ({}),
    querySelector(selector) {
      if (selector === '.el-scrollbar__view') return playlist;
      if (selector === '#dPlayerVideoMain') return player;
      if (selector === '.item1title') return { textContent: '测试课程' };
      if (stalePlayOverlay && selector === '.d-play-btn') return centerPlay;
      if (stalePlayOverlay && selector.includes('.d-control-tool')) return toolbar;
      return null;
    },
    querySelectorAll: (selector) => selector === '.vvitem' ? lessons : [],
  });
  const schedule = (callback, delay, repeat = false) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay, repeat, delay });
    return id;
  };
  const win = new EventTarget();
  Object.assign(win, {
    localStorage: storage(), sessionStorage: storage(), navigator: {}, closed: false,
    location: {
      href: 'https://www.sqgj.gov.cn/study?installId=2026&courseId=test',
      pathname: '/study', search: '?installId=2026&courseId=test',
      reloadCount: 0,
      reload() { this.reloadCount++; },
      replace(url) { this.href = url; },
    },
    setTimeout: (callback, delay) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    close() { this.closed = closeAllowed; },
    getComputedStyle: () => ({ display: 'flex', visibility: 'visible', opacity: '1' }),
  });
  const context = vm.createContext({
    module: { exports: {} }, URL, URLSearchParams,
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), table() {} },
    Date: class extends Date { static now() { return now; } },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext(source, context);
  const api = context.module.exports;
  const initial = api.migrateState({
    enabled: true, runId: 'test-run', mode: api.MODE.entering,
    anchor: { courseKey: 'test-course', courseTitle: '测试课程' },
    currentCourse: {
      key: 'test-course', title: '测试课程', installId: '2026', page: 1, index: 0,
      returnUrl: doc.referrer,
    },
  });
  win.localStorage.setItem('sqgjCourseMarathon', JSON.stringify(initial));
  api.run({ window: win, document: doc });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const advance = async (ms) => {
    await flush();
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.repeat) timer.at += timer.delay;
      else timers.delete(id);
      timer.callback();
      await flush();
    }
    now = end;
    await flush();
  };
  const state = () => JSON.parse(win.localStorage.getItem('sqgjCourseMarathon'));
  const finishLesson = async (index, { progress = 100 } = {}) => {
    lessons[index].progress.value = progress;
    player.currentTime = player.duration;
    player.ended = true;
    player.paused = true;
    // Media ended does not bubble, but is observable in document capture phase.
    for (const listener of capture.get('ended') || []) listener({ target: player, type: 'ended' });
    player.dispatchEvent(new Event('ended'));
    await flush();
  };
  const ack = ({ advanceCourse = false } = {}) => {
    const current = state();
    win.localStorage.setItem('sqgjCourseMarathonListReturnAck', JSON.stringify({
      runId: current.runId, courseKey: current.currentCourse.key,
      handoffId: current.currentCourse.completionEvidence.returnHandoffId,
      updatedAt: now, href: doc.referrer,
    }));
    if (advanceCourse) {
      current.mode = 'playing';
      current.currentCourse = { key: 'next-course', title: '下一课程' };
      win.localStorage.setItem('sqgjCourseMarathon', JSON.stringify(current));
    }
  };
  return { win, player, lessons, state, advance, finishLesson, ack, logs, toolbar };
}

test('真实运行流程：上集结束后下集播放，最后一集结束后返回课程列表', async () => {
  const page = studyFixture();
  await page.advance(500);
  await page.finishLesson(0);
  assert.equal(page.lessons[1].active, true);
  assert.equal(page.state().mode, 'playing');
  assert.equal(page.player.paused, false);
  await page.finishLesson(1);
  assert.equal(page.state().mode, 'returning');
  await page.advance(12_500);
  assert.match(page.win.location.href, /ongoingTopicDetail/);
});

test('网站自己的 ended 回调立即重置视频时，仍能切到下一子章节', async () => {
  const page = studyFixture({ resetOnEnded: true });
  await page.advance(500);
  await page.finishLesson(0);
  assert.equal(page.lessons[1].active, true);
  assert.equal(page.state().mode, 'playing');
  assert.equal(page.player.paused, false);
});

test('浏览器禁止关闭已完成课程页时，停止心跳以便列表继续下一大课程', async () => {
  const page = studyFixture({ completed: true, closeAllowed: false });
  await page.advance(500);
  assert.equal(page.state().mode, 'returning');
  page.ack();
  await page.advance(5_000);
  assert.equal(page.win.closed, false);
  assert.equal(page.win.localStorage.getItem('sqgjCourseMarathonStudyHeartbeat'), null);
});

test('中央图标过时但视频实际在播放时，不反复点击播放暂停控件', async () => {
  const page = studyFixture({ stalePlayOverlay: true });
  await page.advance(500);
  for (let i = 0; i < 5; i++) {
    page.player.currentTime += 1.5;
    await page.advance(1_500);
  }
  assert.equal(page.toolbar.clicks, 0);
  assert.equal(page.player.paused, false);
});

test('子章节真实结束后仍等待网站进度确认，不会因结束事件直接跳课', async () => {
  const page = studyFixture({ resetOnEnded: true });
  await page.advance(500);
  await page.finishLesson(0, { progress: 95 });
  await page.advance(1_000);
  assert.equal(page.lessons[0].active, true);
  assert.equal(page.state().mode, 'confirming');
  page.lessons[0].progress.value = 100;
  await page.advance(500);
  assert.equal(page.lessons[1].active, true);
  assert.equal(page.state().mode, 'playing');
});

test('列表已经开始下一门时，仍能确认上一门的交接并关闭完成页', async () => {
  const page = studyFixture({ completed: true });
  await page.advance(500);
  page.ack({ advanceCourse: true });
  await page.advance(500);
  assert.equal(page.win.closed, true);
  assert.equal(page.state().currentCourse.key, 'next-course');
  assert.match(page.win.location.href, /\/study\?/);
});

// ==UserScript==
// @name         SQGJ 列表轮播
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  每个 installId 独立轮播，始终从第一个未满 100% 的课程开始
// @match        https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STATE_KEY = 'sqgjCourseMarathon';
  const COOL_DOWN_MS = 30_000;

  const installId =
    new URLSearchParams(window.location.search).get('installId') || 'default';
  const homeUrl = window.location.href;

  const defaultState = {
    enabled: true,
    activeInstallId: installId,
    installs: {},
  };

  const defaultInstall = {
    mode: 'list',      // list | entering | course | returning | idle
    currentCourse: null,
    lastCourse: null,
    lastFinished: 0,
    returnUrl: homeUrl,
    homeUrl,
  };

  const readState = () => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}');
      return {
        ...defaultState,
        ...stored,
        installs: { ...(stored.installs || {}) },
      };
    } catch {
      return { ...defaultState, installs: {} };
    }
  };

  const writeState = (state) => {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  };

  const ensureInstallState = (state, id = installId) => {
    if (!state.installs[id]) {
      state.installs[id] = { ...defaultInstall };
    } else {
      state.installs[id].homeUrl = state.installs[id].homeUrl || homeUrl;
    }
    return state.installs[id];
  };

  const text = (el) => (el ? el.textContent.trim() : '');

  const waitForList = () =>
    new Promise((resolve) => {
      const existing = document.querySelector('.ongoingTopicDetail .list');
      if (existing) {
        resolve(existing);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector('.ongoingTopicDetail .list');
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

  const hasNextPage = () => {
    const btn = document.querySelector('.el-pagination .btn-next');
    if (!btn) return false;
    return !(
      btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('is-disabled')
    );
  };

  const goNextPage = () => {
    const btn = document.querySelector('.el-pagination .btn-next');
    if (!btn) return false;
    btn.click();
    console.log('[SQGJ 列表] 翻到下一页');
    return true;
  };

  const listCourses = () =>
    Array.from(document.querySelectorAll('.ongoingTopicDetail .list .item'))
      .map((el) => {
        const title = text(el.querySelector('.itemtitle'));
        const progressEl = el.querySelector('.el-progress');
        const progress = progressEl ? Number(progressEl.getAttribute('aria-valuenow')) || 0 : 0;
        const playBtn = Array.from(el.querySelectorAll('.btnview .btn')).find((btn) =>
          /继续学习|开始学习/.test(btn.textContent)
        );
        return { el, title, progress, playBtn };
      })
      .filter((c) => c.title && c.playBtn);

  const processList = () => {
    if (!document.querySelector('.ongoingTopicDetail .list')) return;

    const state = readState();
    state.activeInstallId = installId;
    writeState(state);

    if (state.enabled === false) return;

    const installState = ensureInstallState(state);
    if (installState.mode === 'entering' || installState.mode === 'course') return;

    if (installState.mode === 'returning') {
      installState.mode = 'list';
      writeState(state);
    }

    const courses = listCourses();
    if (!courses.length) return;

    const now = Date.now();
    const candidate = courses.find((course) => {
      if (course.progress >= 100) return false;
      if (course.title === installState.lastCourse && now - installState.lastFinished < COOL_DOWN_MS) {
        return false;
      }
      return true;
    });

    if (candidate) {
      installState.mode = 'entering';
      installState.currentCourse = candidate.title;
      installState.lastCourse = candidate.title;
      installState.lastFinished = Date.now();
      installState.returnUrl = homeUrl;
      state.activeInstallId = installId;
      writeState(state);

      console.log('[SQGJ 列表] 进入课程：', candidate.title, `（进度 ${candidate.progress}%）`);
      candidate.playBtn.click();
      return;
    }

    if (hasNextPage()) {
      goNextPage();
      return;
    }

    installState.mode = 'idle';
    state.activeInstallId = installId;
    writeState(state);
    console.log('[SQGJ 列表] 当前列表全部课程已播放完成。');
  };

  let loopStarted = false;
  const startLoop = () => {
    if (loopStarted) return;
    loopStarted = true;
    processList();
    setInterval(processList, 4000);
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) processList();
  });

  waitForList().then(startLoop);

  window.startCourseMarathon = () => {
    const state = readState();
    const installState = ensureInstallState(state);
    state.enabled = true;
    state.activeInstallId = installId;
    installState.mode = 'list';
    writeState(state);
    console.log('[SQGJ 列表] 自动轮播已开启（installId=', installId, '）');
    processList();
  };

  window.stopCourseMarathon = () => {
    const state = readState();
    state.enabled = false;
    writeState(state);
    console.log('[SQGJ 列表] 自动轮播已暂停');
  };

  window.resetCourseMarathonState = () => {
    const state = readState();
    delete state.installs[installId];
    state.activeInstallId = installId;
    writeState(state);
    console.log('[SQGJ 列表] 已清空 installId=', installId, ' 的状态');
  };
})();

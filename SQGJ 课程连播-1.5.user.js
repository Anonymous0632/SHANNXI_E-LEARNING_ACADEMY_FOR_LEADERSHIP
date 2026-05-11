// ==UserScript==
// @name         SQGJ 课程连播
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  静音连播并回到所属列表
// @match        https://www.sqgj.gov.cn/study*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STATE_KEY = 'sqgjCourseMarathon';
  const ITEM_SELECTOR = '.vvitem';
  const TITLE_SELECTOR = '.vvitemtitle';
  const ACTIVE_CLASS = 'accc';
  const VIDEO_SELECTOR = '#dPlayerVideoMain';
  const WAIT_TIMEOUT_MS = 30000;
  const MONITOR_INTERVAL_MS = 1500;

  const log = (...args) => console.log('[SQGJ 课程]', ...args);
  const warn = (...args) => console.warn('[SQGJ 课程]', ...args);

  const defaultState = {
    enabled: true,
    activeInstallId: 'default',
    installs: {},
  };

  const defaultInstall = {
    mode: 'list',
    currentCourse: null,
    lastCourse: null,
    lastFinished: 0,
    returnUrl: null,
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

  const ensureInstallState = (state, id) => {
    if (!state.installs[id]) {
      state.installs[id] = { ...defaultInstall };
    }
    return state.installs[id];
  };

  const text = (el) => (el ? el.textContent.trim() : '');

  const getPlaylistItems = () => Array.from(document.querySelectorAll(ITEM_SELECTOR));

  const getProgress = (item) => {
    const circle = item.querySelector('[aria-valuenow]');
    return circle ? Number(circle.getAttribute('aria-valuenow')) || 0 : 0;
  };

  const isIncomplete = (item) => getProgress(item) < 100;

  const findFirstIncompleteIndex = (items = getPlaylistItems()) =>
    items.findIndex(isIncomplete);

  const findCurrentIndex = () => {
    const items = getPlaylistItems();
    const firstIncomplete = findFirstIncompleteIndex(items);
    if (firstIncomplete !== -1) return firstIncomplete;

    const active = items.findIndex((item) =>
      item.querySelector(`${TITLE_SELECTOR}.${ACTIVE_CLASS}`)
    );
    if (active !== -1) return active;
    return 0;
  };

  const findNextIndex = (start) => {
    const items = getPlaylistItems();
    for (let i = start + 1; i < items.length; i += 1) {
      if (isIncomplete(items[i])) return i;
    }
    for (let i = 0; i < start; i += 1) {
      if (isIncomplete(items[i])) return i;
    }
    return null;
  };

  const clickItem = (idx) => {
    const items = getPlaylistItems();
    const item = items[idx];
    if (!item) return;
    const clickable = item.querySelector(TITLE_SELECTOR) || item;
    clickable.click();
    log('切换到第', idx + 1, '条：', text(clickable) || `条目 ${idx + 1}`);
  };

  let initialized = false;
  let finishedCourse = false;
  let lastSourceToken = null;
  let videoEnded = false;

  const shouldAutoPlay = (player) => {
    if (!player || finishedCourse || videoEnded) return false;
    if (player.ended) return false;
    if (player.readyState < 2) return false;
    if (!player.paused) return false;
    return true;
  };

  const bindPlayer = (player, handleEnded) => {
    if (!player) return false;
    if (!player._sqgjBound) {
      player._sqgjBound = true;
      player._sqgjPauseHandler = () => {
        if (finishedCourse || videoEnded) return;
        if (player.ended) return;
        if (player.currentTime < 0.05) return;
        setTimeout(() => tryAutoPlay(player), 200);
      };
      player._sqgjVolumeHandler = () => {
        if (!player.muted || player.volume > 0) {
          player.muted = true;
          player.volume = 0;
        }
      };
      player._sqgjLoadedHandler = () => {
        if (finishedCourse) return;
        scheduleAutoPlay(player);
      };
      player._sqgjEndedHandler = () => handleEnded('ended-event');
      player._sqgjErrorHandler = () => {
        warn('检测到播放器 error 事件', {
          currentSrc: player.currentSrc || '',
          networkState: player.networkState,
          readyState: player.readyState,
          error: player.error ? player.error.message || player.error.code : null,
        });
      };
      player.addEventListener('pause', player._sqgjPauseHandler);
      player.addEventListener('volumechange', player._sqgjVolumeHandler);
      player.addEventListener('loadeddata', player._sqgjLoadedHandler);
      player.addEventListener('ended', player._sqgjEndedHandler);
      player.addEventListener('error', player._sqgjErrorHandler);
      log('已绑定播放器事件', player.currentSrc || player.dataset.src || '(无 src)');
    }
    scheduleAutoPlay(player);
    return true;
  };

  const scheduleAutoPlay = (player) => {
    const src = player.currentSrc || player.dataset.src || `time-${Date.now()}`;
    if (src === lastSourceToken && !player.ended) return;
    lastSourceToken = src;
    videoEnded = false;
    setTimeout(() => tryAutoPlay(player), 120);
  };

  const tryAutoPlay = (player) => {
    if (!shouldAutoPlay(player)) return;

    player.muted = true;
    player.volume = 0;
    const attempt = player.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => {
        const overlay = document.querySelector('.d-play-btn');
        if (overlay && overlay.style.display !== 'none') {
          overlay.click();
        } else {
          const area = document.querySelector('.d-player-video-main');
          if (area) area.click();
        }
        setTimeout(() => {
          if (finishedCourse || videoEnded) return;
          player.muted = true;
          player.volume = 0;
          player.play().catch(() => {});
        }, 400);
      });
    }
  };

  const cleanupPlayer = (player) => {
    if (!player || !player._sqgjBound) return;
    player.removeEventListener('pause', player._sqgjPauseHandler);
    player.removeEventListener('volumechange', player._sqgjVolumeHandler);
    player.removeEventListener('loadeddata', player._sqgjLoadedHandler);
    player.removeEventListener('ended', player._sqgjEndedHandler);
    player.removeEventListener('error', player._sqgjErrorHandler);
    player._sqgjBound = false;
  };

  const initAutomation = () => {
    if (initialized) return;
    initialized = true;

    const state = readState();
    const activeId = state.activeInstallId || 'default';
    const installState = ensureInstallState(state, activeId);

    const courseTitle =
      text(document.querySelector('.item1title')) || installState.currentCourse || '当前课程';

    installState.mode = 'course';
    installState.currentCourse = courseTitle;
    installState.lastCourse = courseTitle;
    writeState(state);

    let playlistObserver = { disconnect() {} };
    let videoObserver = { disconnect() {} };
    let currentIndex = 0;
    let switching = false;
    let monitorTimer = null;
    let visibilityHandler = null;
    let focusHandler = null;

    const stopMonitor = () => {
      if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
      }
    };

    const getCurrentProgress = () => {
      const items = getPlaylistItems();
      const item = items[currentIndex];
      return item ? getProgress(item) : 0;
    };

    const handleEnded = (reason = 'unknown') => {
      if (switching) return;
      switching = true;
      log('检测到当前视频结束，原因：', reason);

      const player = document.querySelector(VIDEO_SELECTOR);
      if (player) {
        videoEnded = true;
        player.pause();
      }

      const next = findNextIndex(currentIndex);
      if (next == null) {
        finishedCourse = true;
        stopMonitor();
        cleanupPlayer(player);

        installState.mode = 'returning';
        installState.currentCourse = null;
        installState.lastFinished = Date.now();
        const targetUrl =
          installState.returnUrl ||
          installState.homeUrl ||
          (activeId === 'default'
            ? '/learningClassroom/ongoingTopicDetail'
            : `/learningClassroom/ongoingTopicDetail?installId=${encodeURIComponent(activeId)}`);
        writeState(state);

        log('当前课程播放完成，返回：', targetUrl);
        setTimeout(() => {
          window.location.href = targetUrl;
        }, 1500);
        return;
      }

      currentIndex = next;
      finishedCourse = false;
      videoEnded = false;
      lastSourceToken = null;

      setTimeout(() => {
        clickItem(next);
        setTimeout(() => {
          const newPlayer = document.querySelector(VIDEO_SELECTOR);
          if (!newPlayer) {
            warn('切换后未找到播放器，等待观察器重新绑定');
            switching = false;
            return;
          }
          bindPlayer(newPlayer, handleEnded);
          switching = false;
        }, 500);
      }, 600);
    };

    const startMonitor = () => {
      stopMonitor();
      monitorTimer = setInterval(() => {
        if (finishedCourse || switching) return;

        const player = document.querySelector(VIDEO_SELECTOR);
        if (player && player.ended && player.currentTime > 0) {
          handleEnded('poll-player-ended');
          return;
        }

        if (shouldAutoPlay(player)) {
          tryAutoPlay(player);
        }

        const progress = getCurrentProgress();
        if (progress >= 100 && (!player || player.paused || player.readyState < 3)) {
          handleEnded('poll-progress-100');
        }
      }, MONITOR_INTERVAL_MS);
    };

    Promise.all([
      ensurePlaylist().catch(() => null),
      waitForVideo().catch(() => null),
    ])
      .then(() => {
        const items = getPlaylistItems();
        if (!items.length) {
          warn('未找到课程目录项');
          return;
        }

        currentIndex = findCurrentIndex();
        finishedCourse = false;
        videoEnded = false;
        lastSourceToken = null;

        clickItem(currentIndex);

        const player = document.querySelector(VIDEO_SELECTOR);
        if (player) {
          bindPlayer(player, handleEnded);
        }
        startMonitor();
        visibilityHandler = () => {
          if (document.hidden) return;
          const currentPlayer = document.querySelector(VIDEO_SELECTOR);
          if (shouldAutoPlay(currentPlayer)) {
            log('页面重新可见，尝试恢复播放');
            tryAutoPlay(currentPlayer);
          }
        };
        focusHandler = () => {
          const currentPlayer = document.querySelector(VIDEO_SELECTOR);
          if (shouldAutoPlay(currentPlayer)) {
            log('窗口重新聚焦，尝试恢复播放');
            tryAutoPlay(currentPlayer);
          }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
        window.addEventListener('focus', focusHandler);
        log('连播脚本已启动');

        const playlistContainer = document.querySelector('.el-scrollbar__view');
        if (playlistContainer) {
          playlistObserver = new MutationObserver(() => {
            const itemsNow = getPlaylistItems();
            if (!itemsNow.length) return;
            if (currentIndex >= itemsNow.length) {
              currentIndex = findCurrentIndex();
            }
          });
          playlistObserver.observe(playlistContainer, { childList: true, subtree: true });
        }

        const videoWrap =
          document.getElementById('dPlayerVideo') || document.getElementById('refPlayerWrap');
        if (videoWrap) {
          videoObserver = new MutationObserver(() => {
            const vid = document.querySelector(VIDEO_SELECTOR);
            if (!vid) return;
            bindPlayer(vid, handleEnded);
          });
          videoObserver.observe(videoWrap, { childList: true, subtree: true });
        }
      })
      .catch((err) => warn(err.message || err));
  };

  const waitForVideo = (timeout = WAIT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const video = document.querySelector(VIDEO_SELECTOR);
      if (video) {
        resolve(video);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector(VIDEO_SELECTOR);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待 ${VIDEO_SELECTOR} 超时`));
      }, timeout);
    });

  const ensurePlaylist = (timeout = WAIT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const existing = document.querySelector('.el-scrollbar__view');
      if (existing) {
        resolve(existing);
        return;
      }
      const observer = new MutationObserver(() => {
        const el = document.querySelector('.el-scrollbar__view');
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error('等待课程目录超时'));
      }, timeout);
    });

  const bootstrapObserver = new MutationObserver(() => {
    if (document.querySelector(VIDEO_SELECTOR)) initAutomation();
  });
  bootstrapObserver.observe(document.body, { childList: true, subtree: true });

  if (document.querySelector(VIDEO_SELECTOR)) initAutomation();
})();

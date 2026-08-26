// ==UserScript==
// @name         SQGJ 自动连播
// @namespace    http://tampermonkey.net/
// @version      2.2.2
// @description  从手动选择的大课程开始，按页面顺序完成其后的所有已选课程和子视频
// @match        https://www.sqgj.gov.cn/learningClassroom/ongoingTopic*
// @match        https://www.sqgj.gov.cn/study*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  api.run(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_KEY = 'sqgjCourseMarathon';
  const STUDY_HEARTBEAT_KEY = 'sqgjCourseMarathonStudyHeartbeat';
  const LIST_RETURN_ACK_KEY = 'sqgjCourseMarathonListReturnAck';
  const COURSE_LAUNCH_LEASE_KEY = 'sqgjCourseMarathonCourseLaunchLease';
  const COURSE_LAUNCH_LOCK_NAME = 'sqgj-course-marathon-course-launch';
  const STATE_VERSION = 5;
  const TOPIC_URL = 'https://www.sqgj.gov.cn/learningClassroom/ongoingTopic';
  const MAX_RETRY_ROUNDS = 3;
  const WAIT_TIMEOUT_MS = 30_000;
  const LIST_INTERVAL_MS = 2_000;
  const PLAYER_INTERVAL_MS = 1_500;
  const COURSE_CONFIRM_TIMEOUT_MS = 30_000;
  const NAVIGATION_TIMEOUT_MS = 45_000;
  const STUDY_HEARTBEAT_INTERVAL_MS = 1_500;
  const STUDY_HEARTBEAT_TTL_MS = 6_000;
  const STUDY_OWNERSHIP_SETTLE_MS = 400;
  const COURSE_LAUNCH_LEASE_TTL_MS = NAVIGATION_TIMEOUT_MS;
  const LIST_RETURN_ACK_TIMEOUT_MS = 12_000;
  const LIST_RETURN_ACK_TTL_MS = 15_000;
  const LIST_CONFIRM_REFRESH_MS = 5_000;
  const END_TOLERANCE_SECONDS = 1.5;
  const PLAYBACK_ADVANCE_EPSILON_SECONDS = 0.15;
  const PLAYBACK_HEALTH_WINDOW_MS = 10_000;
  const PLAYER_MISSING_GRACE_MS = 8_000;
  const PLAYER_REBIND_AFTER_MS = 12_000;
  const PLAYER_RELOAD_AFTER_MS = 30_000;
  const PLAY_CONTROL_RETRY_MS = 2_000;
  const MAX_STALL_SAMPLE_GAP_MS = PLAYER_INTERVAL_MS * 4;

  const SELECTORS = {
    courseList: '.ongoingTopicDetail .list',
    courseItem: '.ongoingTopicDetail .list .item',
    courseTitle: '.itemtitle',
    courseAction: '.btnview .btn',
    playlist: '.el-scrollbar__view',
    lessonItem: '.vvitem',
    lessonTitle: '.vvitemtitle',
    video: '#dPlayerVideoMain',
    nextPage: '.el-pagination .btn-next',
    previousPage: '.el-pagination .btn-prev',
    activePage: '.el-pagination .el-pager li.active, .el-pagination .number.active',
  };

  const MODE = Object.freeze({
    idle: 'idle',
    paused: 'paused',
    manualStart: 'manual-start',
    entering: 'entering',
    playing: 'playing',
    confirming: 'confirming',
    switching: 'switching',
    returning: 'returning',
    nextCourse: 'next-course',
    scanNextPage: 'scan-next-page',
    nextCategory: 'next-category',
    retryCurrent: 'retry-current',
    retrying: 'retrying',
    blocked: 'blocked',
    complete: 'complete',
  });

  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const safeNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };

  const clampProgress = (value) => Math.min(100, Math.max(0, safeNumber(value, 0)));

  const newRunId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const isFreshStudyHeartbeat = (heartbeat, state, now = Date.now()) => {
    if (!heartbeat || !state?.runId || !state?.currentCourse?.key) return false;
    const updatedAt = safeNumber(heartbeat.updatedAt, 0);
    return Boolean(
      heartbeat.runId === state.runId &&
        heartbeat.courseKey === state.currentCourse.key &&
        updatedAt > 0 &&
        updatedAt <= now + STUDY_HEARTBEAT_TTL_MS &&
        now - updatedAt <= STUDY_HEARTBEAT_TTL_MS
    );
  };

  const planStudyHeartbeat = ({ heartbeat, state, ownerId, now = Date.now() }) => {
    if (!isFreshStudyHeartbeat(heartbeat, state, now)) return 'claim';
    return heartbeat.ownerId === ownerId ? 'renew' : 'yield';
  };

  const isStudyHeartbeatOwner = (heartbeat, state, ownerId, now = Date.now()) =>
    planStudyHeartbeat({ heartbeat, state, ownerId, now }) === 'renew';

  const isFreshCourseLaunchLease = (lease, state, courseKey, now = Date.now()) => {
    if (!lease || !state?.runId || !courseKey) return false;
    const updatedAt = safeNumber(lease.updatedAt, 0);
    return Boolean(
      lease.runId === state.runId &&
        lease.courseKey === courseKey &&
        updatedAt > 0 &&
        updatedAt <= now + COURSE_LAUNCH_LEASE_TTL_MS &&
        now - updatedAt <= COURSE_LAUNCH_LEASE_TTL_MS
    );
  };

  const isFreshListReturnAck = (ack, state, now = Date.now()) => {
    const evidence = state?.currentCourse?.completionEvidence;
    const handoffId = normalizeText(evidence?.returnHandoffId);
    if (!ack || !state?.runId || !state?.currentCourse?.key || !handoffId) return false;
    const updatedAt = safeNumber(ack.updatedAt, 0);
    return Boolean(
      ack.runId === state.runId &&
        ack.courseKey === state.currentCourse.key &&
        ack.handoffId === handoffId &&
        updatedAt >= safeNumber(evidence.allLessonsConfirmedAt, 0) &&
        updatedAt > 0 &&
        updatedAt <= now + LIST_RETURN_ACK_TTL_MS &&
        now - updatedAt <= LIST_RETURN_ACK_TTL_MS
    );
  };

  const planCourseReturn = ({ listAckFresh }) =>
    listAckFresh ? 'close-study-tab' : 'navigate-current-tab';

  const isStudyOwnershipCurrent = (state, runId, courseKey) =>
    Boolean(
      state?.enabled &&
        runId &&
        courseKey &&
        state.runId === runId &&
        state.currentCourse?.key === courseKey
    );

  const shouldSyncPlayControl = ({ controlVisible, controlState, ended, readyState }) =>
    Boolean(controlVisible && controlState === 'paused' && !ended && safeNumber(readyState, 0) >= 2);

  const isVisibleControlMetrics = ({ width, height, display, visibility, opacity }) => {
    const normalizedOpacity = opacity == null || opacity === '' ? 1 : safeNumber(opacity, 1);
    return Boolean(
      safeNumber(width, 0) > 0 &&
        safeNumber(height, 0) > 0 &&
        display !== 'none' &&
        visibility !== 'hidden' &&
        visibility !== 'collapse' &&
        normalizedOpacity > 0
    );
  };

  const createDefaultState = () => ({
    version: STATE_VERSION,
    enabled: true,
    runId: '',
    mode: MODE.idle,
    topicUrl: TOPIC_URL,
    categoryEntries: [],
    currentCategory: null,
    anchor: null,
    currentCourse: null,
    retry: {
      courseKey: null,
      count: 0,
      reason: null,
    },
    confirmStartedAt: 0,
    lastActionAt: 0,
    externalStudyOwned: false,
    activeInstallId: 'default',
    installs: {},
  });

  const migrateState = (rawState) => {
    const raw = rawState && typeof rawState === 'object' ? rawState : {};
    const state = {
      ...createDefaultState(),
      ...raw,
      version: STATE_VERSION,
      enabled: raw.enabled !== false,
      externalStudyOwned: raw.externalStudyOwned === true,
      categoryEntries: Array.isArray(raw.categoryEntries) ? raw.categoryEntries : [],
      retry: {
        ...createDefaultState().retry,
        ...(raw.retry && typeof raw.retry === 'object' ? raw.retry : {}),
      },
      installs: raw.installs && typeof raw.installs === 'object' ? { ...raw.installs } : {},
    };

    const legacyInstallId = raw.activeInstallId || 'default';
    const legacyInstall = state.installs[legacyInstallId];
    if (!state.currentCourse && legacyInstall && legacyInstall.currentCourse) {
      state.currentCourse = {
        key: `legacy|${legacyInstallId}|${normalizeText(legacyInstall.currentCourse)}`,
        title: normalizeText(legacyInstall.currentCourse),
        installId: legacyInstallId,
        page: 1,
        index: -1,
        returnUrl: legacyInstall.returnUrl || legacyInstall.homeUrl || null,
        confirmedComplete: false,
      };
    }
    if ((!raw.mode || raw.mode === 'list') && legacyInstall && legacyInstall.mode) {
      state.mode = legacyInstall.mode === 'course' ? MODE.playing : legacyInstall.mode;
    }
    if (state.currentCourse && typeof state.currentCourse === 'object') {
      state.currentCourse = {
        confirmedComplete: false,
        removedFromActiveList: false,
        completionEvidence: null,
        ...state.currentCourse,
      };
    }
    if (!state.runId && state.currentCourse) state.runId = newRunId();
    return state;
  };

  const makeCourseKey = ({ installId, page, index, title, href }) => {
    const stableHref = normalizeText(href).replace(/^https?:\/\/[^/]+/i, '');
    return [installId || 'default', safeNumber(page, 1), safeNumber(index, -1), stableHref, normalizeText(title)]
      .join('|');
  };

  const makeLessonKey = ({ index, title, id }) =>
    [normalizeText(id), safeNumber(index, -1), normalizeText(title)].join('|');

  const findFirstIncompleteIndex = (items, startIndex = 0) => {
    for (let index = Math.max(0, startIndex); index < items.length; index += 1) {
      if (clampProgress(items[index].progress) < 100) return index;
    }
    return null;
  };

  const findNextIncompleteIndex = (items, currentIndex, wrap = true) => {
    const after = findFirstIncompleteIndex(items, Math.max(-1, currentIndex) + 1);
    if (after != null || !wrap) return after;
    for (let index = 0; index < Math.max(0, currentIndex); index += 1) {
      if (clampProgress(items[index].progress) < 100) return index;
    }
    return null;
  };

  const hasConfirmedCourseCompletion = (state) => {
    const course = state?.currentCourse;
    const evidence = course?.completionEvidence;
    return Boolean(
      course &&
        evidence &&
        evidence.runId === state.runId &&
        evidence.courseKey === course.key &&
        safeNumber(evidence.allLessonsConfirmedAt, 0) > 0 &&
        safeNumber(evidence.lessonCount, 0) > 0 &&
        safeNumber(evidence.completedLessonCount, 0) >= safeNumber(evidence.lessonCount, 0)
    );
  };

  const selectFollowingCourse = (courses, currentCourse, { currentRemoved = false } = {}) => {
    if (!courses.length) return null;
    let currentIndex = -1;
    if (currentCourse && currentRemoved && Number.isInteger(currentCourse.index)) {
      // 已完成课程会从“在学课程”列表中消失，后续课程会前移到它原来的位置。
      currentIndex = currentCourse.index - 1;
    } else if (currentCourse) {
      currentIndex = courses.findIndex((course) => course.key === currentCourse.key);
      if (currentIndex === -1 && currentCourse.title) {
        currentIndex = courses.findIndex(
          (course) => normalizeText(course.title) === normalizeText(currentCourse.title)
        );
      }
      if (currentIndex === -1 && Number.isInteger(currentCourse.index)) {
        currentIndex = currentCourse.index;
      }
    }
    for (let index = Math.max(0, currentIndex + 1); index < courses.length; index += 1) {
      if (clampProgress(courses[index].progress) < 100) return courses[index];
    }
    return null;
  };

  const groupRank = (group) => {
    if (group === 'annual') return 0;
    if (group === 'special') return 1;
    return 99;
  };

  const orderCategoryEntries = (entries) =>
    entries
      .map((entry, index) => ({ ...entry, sourceOrder: safeNumber(entry.sourceOrder, index) }))
      .sort((left, right) => {
        const rankDiff = groupRank(left.group) - groupRank(right.group);
        return rankDiff || left.sourceOrder - right.sourceOrder;
      });

  const selectNextCategoryEntry = (entries, currentCategory) => {
    if (!currentCategory) return { status: 'unresolved', entry: null };
    const ordered = orderCategoryEntries(entries);
    const currentIndex = ordered.findIndex(
      (entry) =>
        entry.key === currentCategory.key ||
        (entry.installId === currentCategory.installId && entry.group === currentCategory.group)
    );
    if (currentIndex === -1) return { status: 'unresolved', entry: null };
    const entry = ordered.slice(currentIndex + 1).find((candidate) => candidate.groupRank <= 1) || null;
    return entry ? { status: 'next', entry } : { status: 'complete', entry: null };
  };

  const shouldAcceptEnded = ({
    ended,
    currentTime,
    duration,
    sourceToken,
    expectedSourceToken,
    progress,
  }) => {
    const validDuration = Number.isFinite(duration) && duration > 0;
    const nearEnd = validDuration && currentTime >= Math.max(0, duration - END_TOLERANCE_SECONDS);
    const sameSource = Boolean(sourceToken) && sourceToken === expectedSourceToken;
    return Boolean(ended && nearEnd && sameSource && clampProgress(progress) >= 100);
  };

  const hasVerifiedEndedSnapshot = ({
    ended,
    currentTime,
    duration,
    sourceToken,
    expectedSourceToken,
  }) => {
    const validDuration = Number.isFinite(duration) && duration > 0;
    const nearEnd = validDuration && currentTime >= Math.max(0, duration - END_TOLERANCE_SECONDS);
    const sameSource = Boolean(sourceToken) && sourceToken === expectedSourceToken;
    return Boolean(ended && nearEnd && sameSource);
  };

  const shouldConfirmLessonCompletion = ({ verifiedEnded, progress }) =>
    Boolean(verifiedEnded && clampProgress(progress) >= 100);

  const createPlaybackHealth = () => ({
    sourceToken: '',
    lastTime: 0,
    lastObservedAt: 0,
    lastAdvancedAt: 0,
  });

  const createStallClock = () => ({
    accumulatedMs: 0,
    lastSampleAt: 0,
  });

  const observeStallClock = (
    currentClock,
    { progressing, now = Date.now(), maxSampleGapMs = MAX_STALL_SAMPLE_GAP_MS }
  ) => {
    const previous = currentClock || createStallClock();
    const normalizedNow = Math.max(0, safeNumber(now, Date.now()));
    if (progressing) {
      return { accumulatedMs: 0, lastSampleAt: normalizedNow };
    }
    if (!previous.lastSampleAt) {
      return { accumulatedMs: 0, lastSampleAt: normalizedNow };
    }
    const gap = Math.max(0, normalizedNow - previous.lastSampleAt);
    return {
      accumulatedMs:
        gap <= Math.max(0, safeNumber(maxSampleGapMs, MAX_STALL_SAMPLE_GAP_MS))
          ? previous.accumulatedMs + gap
          : 0,
      lastSampleAt: normalizedNow,
    };
  };

  const observePlaybackProgress = (
    currentHealth,
    {
      sourceToken,
      currentTime,
      ended = false,
      now = Date.now(),
      healthWindowMs = PLAYBACK_HEALTH_WINDOW_MS,
    }
  ) => {
    const previous = currentHealth || createPlaybackHealth();
    const normalizedSource = normalizeText(sourceToken);
    const normalizedTime = Math.max(0, safeNumber(currentTime, 0));
    const normalizedNow = Math.max(0, safeNumber(now, Date.now()));
    const sourceChanged = Boolean(
      normalizedSource && previous.sourceToken && normalizedSource !== previous.sourceToken
    );
    const firstObservation = !previous.lastObservedAt || sourceChanged;
    const advanced = Boolean(
      !firstObservation &&
        !ended &&
        normalizedTime >= previous.lastTime + PLAYBACK_ADVANCE_EPSILON_SECONDS
    );
    const movedBackward = Boolean(
      !firstObservation && normalizedTime + PLAYBACK_ADVANCE_EPSILON_SECONDS < previous.lastTime
    );
    const next = {
      sourceToken: normalizedSource || previous.sourceToken,
      lastTime: normalizedTime,
      lastObservedAt: normalizedNow,
      lastAdvancedAt:
        sourceChanged || movedBackward
          ? 0
          : advanced
            ? normalizedNow
            : previous.lastAdvancedAt,
    };
    const progressing = Boolean(
      !ended &&
        next.lastAdvancedAt &&
        normalizedNow - next.lastAdvancedAt <= Math.max(0, healthWindowMs)
    );
    return { health: next, advanced, progressing, sourceChanged };
  };

  const planRecovery = (currentCount, maxRounds = MAX_RETRY_ROUNDS) => {
    const count = Math.max(0, safeNumber(currentCount, 0)) + 1;
    if (count > maxRounds) return { count, action: 'block' };
    if (count === maxRounds) return { count, action: 'reenter' };
    return { count, action: 'reload' };
  };

  const classifyCategoryGroup = (text) => {
    const normalized = normalizeText(text);
    if (/网络自学|年度网络自学(?:课程)?/.test(normalized)) return 'annual';
    if (/专题培训/.test(normalized)) return 'special';
    return null;
  };

  const applyManualStart = (
    rawState,
    { category, course, runId = newRunId(), timestamp = Date.now() }
  ) => {
    const state = migrateState(rawState);
    state.enabled = true;
    state.runId = runId;
    state.mode = MODE.manualStart;
    state.currentCategory = { ...category };
    state.anchor = {
      categoryKey: category.key,
      categoryGroup: category.group,
      categoryOrder: category.sourceOrder,
      courseKey: course.key,
      courseTitle: course.title,
      page: course.page,
      index: course.index,
    };
    state.currentCourse = { ...course, confirmedComplete: false };
    state.retry = { courseKey: course.key, count: 0, reason: null };
    state.confirmStartedAt = 0;
    state.lastActionAt = timestamp;
    state.externalStudyOwned = false;
    state.activeInstallId = course.installId || category.installId || 'default';
    return state;
  };

  const isElementBefore = (left, right) => {
    if (!left || !right || left === right) return false;
    return Boolean(left.compareDocumentPosition(right) & 4);
  };

  function run(browserRoot) {
    if (!browserRoot || !browserRoot.window || !browserRoot.document) return;

    const win = browserRoot.window;
    const doc = browserRoot.document;
    const log = (...args) => console.log('[SQGJ 自动连播]', ...args);
    const warn = (...args) => console.warn('[SQGJ 自动连播]', ...args);

    let routeController = null;
    let mountedRoute = '';
    const listControllerOwnerId = newRunId();
    let courseLaunchPending = false;

    const parseStoredState = (storage) => {
      const raw = storage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    };

    const readState = () => {
      try {
        const shared = parseStoredState(win.localStorage);
        const legacySession = parseStoredState(win.sessionStorage);
        const state = migrateState(shared || legacySession || {});
        if (!shared && legacySession) {
          win.localStorage.setItem(STATE_KEY, JSON.stringify(state));
        }
        return state;
      } catch (error) {
        warn('读取状态失败，已使用默认状态', error);
        return createDefaultState();
      }
    };

    const writeState = (state) => {
      const normalized = migrateState(state);
      win.localStorage.setItem(STATE_KEY, JSON.stringify(normalized));
      win.sessionStorage.setItem(STATE_KEY, JSON.stringify(normalized));
      return normalized;
    };

    const updateState = (updater) => {
      const state = readState();
      updater(state);
      return writeState(state);
    };

    const readStudyHeartbeat = () => {
      try {
        return JSON.parse(win.localStorage.getItem(STUDY_HEARTBEAT_KEY) || 'null');
      } catch (error) {
        warn('读取跨标签页播放心跳失败', error);
        return null;
      }
    };

    const readListReturnAck = () => {
      try {
        return JSON.parse(win.localStorage.getItem(LIST_RETURN_ACK_KEY) || 'null');
      } catch (error) {
        warn('读取课程列表接管确认失败', error);
        return null;
      }
    };

    const clearListReturnAck = () => {
      try {
        win.localStorage.removeItem(LIST_RETURN_ACK_KEY);
      } catch (error) {
        warn('清理课程列表接管确认失败', error);
      }
    };

    const readCourseLaunchLease = () => {
      try {
        return JSON.parse(win.localStorage.getItem(COURSE_LAUNCH_LEASE_KEY) || 'null');
      } catch (error) {
        warn('读取课程打开租约失败', error);
        return null;
      }
    };

    const acquireCourseLaunchLease = (state, course) => {
      const existing = readCourseLaunchLease();
      if (isFreshCourseLaunchLease(existing, state, course.key)) return null;
      const lease = {
        ownerId: listControllerOwnerId,
        launchId: newRunId(),
        runId: state.runId,
        courseKey: course.key,
        updatedAt: Date.now(),
      };
      try {
        win.localStorage.setItem(COURSE_LAUNCH_LEASE_KEY, JSON.stringify(lease));
        const confirmed = readCourseLaunchLease();
        return confirmed?.ownerId === listControllerOwnerId &&
          confirmed?.launchId === lease.launchId
          ? lease
          : null;
      } catch (error) {
        warn('写入课程打开租约失败', error);
        return null;
      }
    };

    const publishListReturnAck = (state) => {
      const evidence = state?.currentCourse?.completionEvidence;
      if (
        state?.mode !== MODE.returning ||
        !hasConfirmedCourseCompletion(state) ||
        !evidence?.returnHandoffId
      ) {
        return null;
      }
      const ack = {
        runId: state.runId,
        courseKey: state.currentCourse.key,
        handoffId: evidence.returnHandoffId,
        href: win.location.href,
        updatedAt: Date.now(),
      };
      try {
        win.localStorage.setItem(LIST_RETURN_ACK_KEY, JSON.stringify(ack));
        return ack;
      } catch (error) {
        warn('写入课程列表接管确认失败', error);
        return null;
      }
    };

    const isCurrentRun = (runId) => Boolean(runId) && readState().runId === runId;

    const createController = () => {
      let disposed = false;
      const timers = new Set();
      const observers = new Set();
      const listeners = [];

      const setTimer = (callback, delay, repeat = false) => {
        const wrapped = () => {
          if (disposed) return;
          callback();
          if (!repeat) timers.delete(timer);
        };
        const timer = repeat ? win.setInterval(wrapped, delay) : win.setTimeout(wrapped, delay);
        timers.add(timer);
        return timer;
      };

      const observe = (target, options, callback) => {
        if (!target) return null;
        const observer = new MutationObserver(() => {
          if (!disposed) callback();
        });
        observer.observe(target, options);
        observers.add(observer);
        return observer;
      };

      const listen = (target, type, callback, options) => {
        target.addEventListener(type, callback, options);
        listeners.push([target, type, callback, options]);
      };

      const dispose = () => {
        disposed = true;
        timers.forEach((timer) => {
          win.clearTimeout(timer);
          win.clearInterval(timer);
        });
        timers.clear();
        observers.forEach((observer) => observer.disconnect());
        observers.clear();
        listeners.forEach(([target, type, callback, options]) =>
          target.removeEventListener(type, callback, options)
        );
        listeners.length = 0;
      };

      return { setTimer, observe, listen, dispose, isDisposed: () => disposed };
    };

    const waitForElement = (selector, controller, timeout = WAIT_TIMEOUT_MS) =>
      new Promise((resolve, reject) => {
        const existing = doc.querySelector(selector);
        if (existing) {
          resolve(existing);
          return;
        }
        const observer = controller.observe(
          doc.documentElement,
          { childList: true, subtree: true },
          () => {
            const element = doc.querySelector(selector);
            if (element) {
              observer.disconnect();
              resolve(element);
            }
          }
        );
        controller.setTimer(() => {
          if (observer) observer.disconnect();
          reject(new Error(`等待 ${selector} 超时`));
        }, timeout);
      });

    const waitUntil = (predicate, controller, timeout = WAIT_TIMEOUT_MS, interval = 250) =>
      new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = async () => {
          if (controller.isDisposed()) return;
          try {
            const result = await predicate();
            if (result) {
              resolve(result);
              return;
            }
          } catch (error) {
            warn('等待条件检查失败', error);
          }
          if (Date.now() - startedAt >= timeout) {
            reject(new Error('等待页面状态变化超时'));
            return;
          }
          controller.setTimer(check, interval);
        };
        check();
      });

    const getProgressFromElement = (element) => {
      if (!element) return 0;
      const candidates = element.matches('[aria-valuenow], [data-progress], [data-percentage]')
        ? [element]
        : Array.from(
            element.querySelectorAll('[aria-valuenow], [data-progress], [data-percentage]')
          );
      const values = candidates.flatMap((candidate) =>
        ['aria-valuenow', 'data-progress', 'data-percentage']
          .map((attribute) => candidate.getAttribute(attribute))
          .filter((value) => value != null && value !== '')
          .map((value) => clampProgress(value))
      );
      const percentText = normalizeText(element.textContent).match(/(\d+(?:\.\d+)?)\s*%/);
      if (percentText) values.push(clampProgress(percentText[1]));
      if (
        element.matches('.el-progress.is-success, [role="progressbar"].is-success') ||
        element.querySelector('.el-progress.is-success, .el-progress__text .el-icon-check')
      ) {
        values.push(100);
      }
      return values.length ? Math.max(...values) : 0;
    };

    const getActivePage = () => {
      const element = doc.querySelector(SELECTORS.activePage);
      return Math.max(1, safeNumber(normalizeText(element && element.textContent), 1));
    };

    const isPaginationButtonEnabled = (selector) => {
      const button = doc.querySelector(selector);
      if (!button) return false;
      return !(
        button.disabled ||
        button.getAttribute('aria-disabled') === 'true' ||
        button.classList.contains('is-disabled') ||
        button.classList.contains('disabled')
      );
    };

    const clickPagination = (selector) => {
      if (!isPaginationButtonEnabled(selector)) return false;
      doc.querySelector(selector).click();
      return true;
    };

    const getInstallId = () => {
      const current = new URLSearchParams(win.location.search).get('installId');
      if (current) return current;
      try {
        const referrer = doc.referrer ? new URL(doc.referrer) : null;
        const fromReferrer = referrer?.searchParams.get('installId');
        if (fromReferrer) return fromReferrer;
      } catch (error) {
        warn('无法解析来源页面的 installId', error);
      }
      return readState().activeInstallId || 'default';
    };

    const getCourseAction = (item) =>
      Array.from(item.querySelectorAll(`${SELECTORS.courseAction}, button, a`)).find((element) =>
        /继续学习|开始学习|进入学习/.test(normalizeText(element.textContent))
      );

    const collectCourses = () => {
      const installId = getInstallId();
      const page = getActivePage();
      return Array.from(doc.querySelectorAll(SELECTORS.courseItem))
        .map((element, index) => {
          const title = normalizeText(element.querySelector(SELECTORS.courseTitle)?.textContent);
          const action = getCourseAction(element);
          const href = action?.closest('a')?.href || action?.getAttribute('href') || '';
          return {
            element,
            action,
            title,
            progress: getProgressFromElement(element.querySelector('.el-progress') || element),
            installId,
            page,
            index,
            href,
            key: makeCourseKey({ installId, page, index, title, href }),
          };
        })
        .filter((course) => course.title && course.action);
    };

    const serializeCourse = (course, returnUrl = win.location.href) => ({
      key: course.key,
      title: course.title,
      installId: course.installId,
      page: course.page,
      index: course.index,
      href: course.href || '',
      returnUrl,
      confirmedComplete: false,
      removedFromActiveList: false,
      completionEvidence: null,
    });

    const getLessonItems = () =>
      Array.from(doc.querySelectorAll(SELECTORS.lessonItem)).map((element, index) => {
        const titleElement = element.querySelector(SELECTORS.lessonTitle) || element;
        const title = normalizeText(titleElement.textContent);
        const id =
          element.dataset.id ||
          element.dataset.courseId ||
          element.dataset.videoId ||
          titleElement.getAttribute('data-id') ||
          '';
        const active = Boolean(
          element.matches('.accc, .active, [aria-current="true"]') ||
            element.querySelector(`${SELECTORS.lessonTitle}.accc, ${SELECTORS.lessonTitle}.active, [aria-current="true"]`)
        );
        return {
          element,
          titleElement,
          title,
          id,
          index,
          active,
          progress: getProgressFromElement(element),
          key: makeLessonKey({ index, title, id }),
        };
      });

    const getSourceToken = (player) =>
      normalizeText(
        player && (player.currentSrc || player.getAttribute('src') || player.dataset.src || '')
      );

    const collectCategoryHeadings = () =>
      Array.from(
        doc.querySelectorAll('h1, h2, h3, h4, h5, h6, .title, .itemtitle, .module-title, .topic-title')
      )
        .map((element) => ({ element, group: classifyCategoryGroup(element.textContent) }))
        .filter((entry) => entry.group && normalizeText(entry.element.textContent).length < 80);

    const collectCategoryEntries = () => {
      const headings = collectCategoryHeadings();
      const actions = Array.from(
        doc.querySelectorAll('a[href*="/learningClassroom/ongoingTopicDetail"], [data-href*="/learningClassroom/ongoingTopicDetail"]')
      );
      const seen = new Set();
      const entries = [];

      actions.forEach((action, sourceOrder) => {
        const href = action.href || action.getAttribute('data-href') || '';
        if (!href || seen.has(href)) return;
        let group = null;
        headings.forEach((heading) => {
          if (isElementBefore(heading.element, action)) group = heading.group;
        });
        if (!group) {
          const contextText = normalizeText(
            action.closest('.item, .card, .module, .section, li, article')?.textContent
          );
          group = classifyCategoryGroup(contextText);
        }
        if (!group) return;
        const container = action.closest('.item, .card, li, article, .module') || action;
        const title = normalizeText(
          container.querySelector('.itemtitle, .title, h3, h4, h5')?.textContent || action.textContent
        );
        const absoluteHref = new URL(href, win.location.href).href;
        const installId = new URL(absoluteHref).searchParams.get('installId') || 'default';
        seen.add(href);
        entries.push({
          key: `${group}|${installId}|${absoluteHref}|${title}`,
          group,
          groupRank: groupRank(group),
          sourceOrder,
          title,
          href: absoluteHref,
          installId,
          action,
        });
      });
      return orderCategoryEntries(entries);
    };

    const serializeCategory = (entry) => ({
      key: entry.key,
      group: entry.group,
      groupRank: entry.groupRank,
      sourceOrder: entry.sourceOrder,
      title: entry.title,
      href: entry.href,
      installId: entry.installId,
    });

    const inferCurrentCategory = (state) => {
      const installId = getInstallId();
      const stored = state.categoryEntries.find((entry) => entry.installId === installId);
      if (stored) return stored;
      const bodyText = normalizeText(doc.body.textContent);
      const group = classifyCategoryGroup(bodyText) || state.currentCategory?.group || null;
      return {
        key: `${group || 'unknown'}|${installId}|${win.location.href}`,
        group,
        groupRank: groupRank(group),
        sourceOrder: state.currentCategory?.sourceOrder ?? 0,
        title: normalizeText(doc.querySelector('.breadcrumb, .item1title, h1, h2')?.textContent),
        href: win.location.href,
        installId,
      };
    };

    const blockRun = (reason) => {
      updateState((state) => {
        state.mode = MODE.blocked;
        state.enabled = false;
        state.retry.reason = reason;
        state.lastActionAt = Date.now();
      });
      warn('自动连播已暂停：', reason);
      if (routeController) routeController.dispose();
    };

    const beginManualCourse = (course) => {
      const previous = readState();
      const category = serializeCategory(inferCurrentCategory(previous));
      const serializedCourse = serializeCourse(course);
      writeState(applyManualStart(previous, { category, course: serializedCourse }));
      clearListReturnAck();
      log('已将手动选择设为新起点：', course.title);
    };

    const clickCourse = (course, mode) => {
      if (!course || !course.action || courseLaunchPending) return false;
      const requestedState = readState();
      const requestedRunId = requestedState.runId;
      courseLaunchPending = true;

      const launch = () => {
        const liveState = readState();
        if (!liveState.enabled || liveState.runId !== requestedRunId) return false;
        const lease = acquireCourseLaunchLease(liveState, course);
        if (!lease) {
          log('同一课程已有打开任务，取消本次重复点击：', course.title);
          return false;
        }
        updateState((state) => {
          state.mode = mode;
          state.currentCourse = {
            ...serializeCourse(course),
            launchId: lease.launchId,
            launchRequestedAt: lease.updatedAt,
          };
          state.externalStudyOwned = false;
          state.activeInstallId = course.installId;
          state.confirmStartedAt = 0;
          state.lastActionAt = lease.updatedAt;
        });
        clearListReturnAck();
        log('进入大课程：', {
          courseKey: course.key,
          title: course.title,
          installId: course.installId,
          page: course.page,
          index: course.index,
          progress: course.progress,
          launchId: lease.launchId,
        });
        course.action.click();
        return true;
      };

      const finishLaunch = () => {
        courseLaunchPending = false;
      };
      if (win.navigator?.locks?.request) {
        win.navigator.locks
          .request(COURSE_LAUNCH_LOCK_NAME, { ifAvailable: true }, (lock) => {
            if (!lock) {
              log('另一个列表标签正在打开课程，本页取消重复点击：', course.title);
              return false;
            }
            return launch();
          })
          .catch((error) => warn('课程打开锁执行失败', error))
          .finally(finishLaunch);
      } else {
        try {
          launch();
        } finally {
          finishLaunch();
        }
      }
      return true;
    };

    const recoverFromList = (course, reason) => {
      const state = readState();
      const recovery = planRecovery(state.retry.count);
      if (recovery.action === 'block') {
        blockRun(`${reason}；连续恢复 ${MAX_RETRY_ROUNDS} 轮仍未成功`);
        return;
      }
      updateState((next) => {
        next.retry = {
          courseKey: next.currentCourse?.key || course?.key || null,
          count: recovery.count,
          reason,
        };
        next.mode = MODE.retryCurrent;
        next.confirmStartedAt = 0;
      });
      warn(`准备第 ${recovery.count} 轮恢复当前课程：`, reason);
      if (course) clickCourse(course, MODE.entering);
    };

    const mountTopicRoute = (controller) => {
      const recordEntries = () => {
        const entries = collectCategoryEntries();
        if (!entries.length) return entries;
        updateState((state) => {
          state.topicUrl = win.location.href;
          state.categoryEntries = entries.map(serializeCategory);
        });
        return entries;
      };

      controller.listen(
        doc,
        'click',
        (event) => {
          if (!event.isTrusted) return;
          const action = event.target.closest(
            'a[href*="/learningClassroom/ongoingTopicDetail"], [data-href*="/learningClassroom/ongoingTopicDetail"]'
          );
          if (!action) return;
          const entries = recordEntries();
          const href = action.href || new URL(action.getAttribute('data-href'), win.location.href).href;
          const selected = entries.find((entry) => entry.href === href);
          if (!selected) return;
          updateState((state) => {
            state.currentCategory = serializeCategory(selected);
            state.activeInstallId = selected.installId;
            state.mode = MODE.idle;
          });
          log('已记录手动进入的课程分类：', selected.title || selected.group);
        },
        true
      );

      const continueToNextCategory = () => {
        const state = readState();
        if (!state.enabled || state.mode !== MODE.nextCategory) return;
        const liveEntries = recordEntries();
        const entries = liveEntries.length
          ? liveEntries
          : state.categoryEntries.map((entry) => ({ ...entry, action: null }));
        const selection = selectNextCategoryEntry(entries, state.currentCategory);
        if (selection.status === 'unresolved') {
          blockRun('无法在学习课堂中确认当前分类的位置；为避免回到起点以上，已停止');
          return;
        }
        if (selection.status === 'complete') {
          updateState((nextState) => {
            nextState.mode = MODE.complete;
            nextState.currentCourse = null;
            nextState.lastActionAt = Date.now();
          });
          log('年度网络自学课程和专题培训中，起点以下的课程已处理完毕。');
          return;
        }
        const next = selection.entry;
        updateState((nextState) => {
          nextState.currentCategory = serializeCategory(next);
          nextState.activeInstallId = next.installId;
          nextState.currentCourse = null;
          nextState.mode = MODE.nextCategory;
          nextState.lastActionAt = Date.now();
        });
        log('进入下一个课程分类：', next.title || next.group);
        if (next.href) {
          win.location.href = next.href;
        } else if (next.action) {
          next.action.click();
        } else {
          blockRun('未找到下一个课程分类的可验证入口');
        }
      };

      recordEntries();
      controller.setTimer(continueToNextCategory, 500);
      controller.observe(doc.body, { childList: true, subtree: true }, recordEntries);
    };

    const mountDetailRoute = (controller) => {
      let processing = false;

      controller.listen(
        doc,
        'click',
        (event) => {
          if (!event.isTrusted) return;
          const item = event.target.closest(SELECTORS.courseItem);
          if (!item) return;
          const courses = collectCourses();
          const course = courses.find((candidate) => candidate.element === item);
          if (!course || !course.action?.contains(event.target)) return;
          beginManualCourse(course);
        },
        true
      );

      const moveTowardPage = (targetPage) => {
        const activePage = getActivePage();
        if (activePage === targetPage) return false;
        const selector = activePage < targetPage ? SELECTORS.nextPage : SELECTORS.previousPage;
        if (!clickPagination(selector)) {
          blockRun(`无法返回课程所在的第 ${targetPage} 页`);
          return true;
        }
        log('调整课程列表页码：', activePage, '→', targetPage);
        return true;
      };

      const finishCategory = () => {
        const state = updateState((next) => {
          next.mode = MODE.nextCategory;
          next.currentCourse = null;
          next.confirmStartedAt = 0;
          next.lastActionAt = Date.now();
        });
        log('当前课程分类已处理完毕，返回学习课堂查找后续分类');
        win.location.href = state.topicUrl || TOPIC_URL;
      };

      const scanCurrentOrNextPage = (courses) => {
        const candidate = courses.find((course) => course.progress < 100);
        if (candidate) {
          clickCourse(candidate, MODE.entering);
          return;
        }
        if (clickPagination(SELECTORS.nextPage)) {
          updateState((state) => {
            state.mode = MODE.scanNextPage;
            state.lastActionAt = Date.now();
          });
          log('当前页没有未完成课程，继续下一页');
          return;
        }
        finishCategory();
      };

      const processList = () => {
        if (processing || controller.isDisposed()) return;
        let state = readState();
        if (!state.enabled || state.mode === MODE.paused || state.mode === MODE.blocked) return;
        const list = doc.querySelector(SELECTORS.courseList);
        if (!list) return;
        if (state.mode === MODE.returning && hasConfirmedCourseCompletion(state)) {
          publishListReturnAck(state);
        }
        if (state.externalStudyOwned) {
          const heartbeat = readStudyHeartbeat();
          if (isFreshStudyHeartbeat(heartbeat, state)) return;
          state = updateState((next) => {
            next.externalStudyOwned = false;
            next.lastActionAt = Date.now();
          });
          log('播放标签页心跳已结束，列表页恢复接管队列');
        }
        const courses = collectCourses();
        if (!courses.length && state.mode !== MODE.returning && state.mode !== MODE.nextCourse) return;
        processing = true;
        try {
          if (!state.currentCategory) {
            updateState((next) => {
              next.currentCategory = inferCurrentCategory(next);
              next.activeInstallId = getInstallId();
            });
          }

          if (!state.anchor && state.mode !== MODE.nextCategory) return;

          if (state.mode === MODE.nextCategory || state.mode === MODE.scanNextPage) {
            scanCurrentOrNextPage(courses);
            return;
          }

          const currentCourse = state.currentCourse;
          if (currentCourse?.page && currentCourse.page !== getActivePage()) {
            moveTowardPage(currentCourse.page);
            return;
          }

          let current = null;
          if (currentCourse) {
            current = courses.find((course) => course.key === currentCourse.key);
            if (!current && currentCourse.title) {
              current = courses.find(
                (course) => normalizeText(course.title) === normalizeText(currentCourse.title)
              );
            }
          }

          if ([MODE.playing, MODE.confirming, MODE.switching].includes(state.mode)) {
            const heartbeat = readStudyHeartbeat();
            if (isFreshStudyHeartbeat(heartbeat, state)) return;
            if (Date.now() - state.lastActionAt >= NAVIGATION_TIMEOUT_MS) {
              recoverFromList(current, '课程播放标签页已关闭或失去响应');
            }
            return;
          }

          if (state.mode === MODE.returning) {
            if (isFreshStudyHeartbeat(readStudyHeartbeat(), state)) return;
            const completionConfirmed = hasConfirmedCourseCompletion(state);
            const evidence = currentCourse?.completionEvidence;
            const now = Date.now();
            const confirmStartedAt = state.confirmStartedAt || now;
            const lastListReloadAt = safeNumber(evidence?.lastListReloadAt, 0);
            const shouldRefreshList = Boolean(
              completionConfirmed &&
                (!lastListReloadAt ||
                  (current &&
                    current.progress < 100 &&
                    now - lastListReloadAt >= LIST_CONFIRM_REFRESH_MS &&
                    now - confirmStartedAt < COURSE_CONFIRM_TIMEOUT_MS))
            );

            if (shouldRefreshList) {
              updateState((next) => {
                next.confirmStartedAt = next.confirmStartedAt || now;
                next.currentCourse.completionEvidence = {
                  ...next.currentCourse.completionEvidence,
                  lastListReloadAt: now,
                  listReloadCount:
                    safeNumber(next.currentCourse.completionEvidence?.listReloadCount, 0) + 1,
                };
                next.lastActionAt = now;
              });
              log('播放标签页已关闭，刷新在学课程列表确认大课程完成状态');
              win.location.reload();
              return;
            }

            if (!current) {
              if (!completionConfirmed) {
                recoverFromList(null, '返回列表后未找到刚完成的大课程，且缺少完整子章节完成证据');
                return;
              }
              updateState((next) => {
                next.mode = MODE.nextCourse;
                next.currentCourse = {
                  ...next.currentCourse,
                  confirmedComplete: true,
                  removedFromActiveList: true,
                };
                next.retry = { courseKey: null, count: 0, reason: null };
                next.confirmStartedAt = 0;
                next.lastActionAt = Date.now();
              });
              log('大课程已完成并从“在学课程”列表移除，将从原位置选择下一门：', currentCourse.title);
              return;
            }
            if (current.progress >= 100) {
              updateState((next) => {
                next.mode = MODE.nextCourse;
                next.currentCourse = {
                  ...next.currentCourse,
                  key: current.key,
                  index: current.index,
                  page: current.page,
                  confirmedComplete: true,
                  removedFromActiveList: false,
                };
                next.retry = { courseKey: null, count: 0, reason: null };
                next.confirmStartedAt = 0;
              });
              log('大课程进度已确认 100%：', current.title);
              return;
            }
            if (!state.confirmStartedAt) {
              updateState((next) => {
                next.confirmStartedAt = confirmStartedAt;
              });
            }
            if (Date.now() - confirmStartedAt >= COURSE_CONFIRM_TIMEOUT_MS) {
              recoverFromList(current, `大课程进度仍为 ${current.progress}%`);
            }
            return;
          }

          if (state.mode === MODE.retryCurrent) {
            if (!current) {
              blockRun('恢复时无法在列表中找到当前大课程');
              return;
            }
            clickCourse(current, MODE.entering);
            return;
          }

          if (state.mode === MODE.nextCourse) {
            const nextCourse = selectFollowingCourse(courses, currentCourse, {
              currentRemoved: Boolean(currentCourse?.removedFromActiveList),
            });
            if (nextCourse) {
              clickCourse(nextCourse, MODE.entering);
              return;
            }
            if (clickPagination(SELECTORS.nextPage)) {
              updateState((next) => {
                next.mode = MODE.scanNextPage;
                next.currentCourse = null;
                next.lastActionAt = Date.now();
              });
              return;
            }
            finishCategory();
            return;
          }

          if (
            (state.mode === MODE.manualStart || state.mode === MODE.entering) &&
            Date.now() - state.lastActionAt >= NAVIGATION_TIMEOUT_MS
          ) {
            const heartbeat = readStudyHeartbeat();
            if (isFreshStudyHeartbeat(heartbeat, state)) {
              updateState((next) => {
                next.externalStudyOwned = true;
                next.lastActionAt = Date.now();
              });
              log('检测到同一课程已在其他标签页播放；原列表标签停止重试，由播放标签继续队列');
              return;
            }
            recoverFromList(current, '点击课程后未进入播放页');
          }
        } finally {
          processing = false;
        }
      };

      waitForElement(SELECTORS.courseList, controller)
        .then(() => {
          processList();
          controller.setTimer(processList, LIST_INTERVAL_MS, true);
          controller.observe(doc.querySelector(SELECTORS.courseList), { childList: true, subtree: true }, processList);
          controller.listen(win, 'storage', (event) => {
            if (event.key === STATE_KEY) processList();
          });
        })
        .catch((error) => blockRun(error.message));
    };

    const mountStudyRoute = (controller) => {
      const heartbeatOwnerId = newRunId();
      let ownedRunId = '';
      let ownedCourseKey = '';
      let boundPlayer = null;
      let playerHandlers = null;
      let expectedLessonKey = null;
      let expectedSourceToken = '';
      let confirming = false;
      let recovering = false;
      let finishingCourse = false;
      let playbackHealth = createPlaybackHealth();
      let missingPlayerSince = 0;
      let stallClock = createStallClock();
      let rebindAttempted = false;
      let lastPlayControlAt = 0;
      let duplicateStudyPage = false;

      const claimStudyOwnership = (state) => {
        ownedRunId = state?.runId || '';
        ownedCourseKey = state?.currentCourse?.key || '';
      };

      const matchesStudyState = (state = readState()) =>
        isStudyOwnershipCurrent(state, ownedRunId, ownedCourseKey);

      const ownsStudyState = (state = readState()) =>
        Boolean(
          !duplicateStudyPage &&
            matchesStudyState(state) &&
            isStudyHeartbeatOwner(readStudyHeartbeat(), state, heartbeatOwnerId)
        );

      const initialStudyState = readState();
      if (initialStudyState.currentCourse) claimStudyOwnership(initialStudyState);

      const clearStudyHeartbeat = () => {
        try {
          const heartbeat = readStudyHeartbeat();
          if (heartbeat?.ownerId === heartbeatOwnerId) {
            win.localStorage.removeItem(STUDY_HEARTBEAT_KEY);
          }
        } catch (error) {
          warn('清理跨标签页播放心跳失败', error);
        }
      };

      const retireDuplicateStudyPage = (reason, winnerHeartbeat = null) => {
        if (duplicateStudyPage) return;
        duplicateStudyPage = true;
        const player = doc.querySelector(SELECTORS.video);
        try {
          if (player && !player.paused) player.pause();
        } catch (error) {
          warn('暂停重复课程页失败', error);
        }
        clearStudyHeartbeat();
        warn('检测到同一课程已有唯一播放页，本重复页面已停止：', {
          reason,
          ownerId: heartbeatOwnerId,
          winnerOwnerId: winnerHeartbeat?.ownerId || null,
          courseKey: ownedCourseKey || null,
        });
        const returnUrl = readState().currentCourse?.returnUrl;
        try {
          win.close();
        } catch (_error) {
          // 平台打开的课程标签通常允许关闭；不允许时由下面的返回列表兜底。
        }
        win.setTimeout(() => {
          if (win.closed) return;
          const livePlayer = doc.querySelector(SELECTORS.video);
          try {
            if (livePlayer && !livePlayer.paused) livePlayer.pause();
          } catch (_error) {
            // 即使播放器拒绝暂停，也会立即离开重复课程页。
          }
          if (returnUrl && win.location.href !== returnUrl) win.location.replace(returnUrl);
        }, 800);
        controller.dispose();
      };

      const publishStudyHeartbeat = () => {
        const state = readState();
        if (duplicateStudyPage || !matchesStudyState(state)) return false;
        const existing = readStudyHeartbeat();
        const action = planStudyHeartbeat({
          heartbeat: existing,
          state,
          ownerId: heartbeatOwnerId,
        });
        if (action === 'yield') {
          retireDuplicateStudyPage('同一运行批次和课程存在更新鲜的播放心跳', existing);
          return false;
        }
        try {
          win.localStorage.setItem(
            STUDY_HEARTBEAT_KEY,
            JSON.stringify({
              ownerId: heartbeatOwnerId,
              runId: state.runId,
              courseKey: state.currentCourse.key,
              href: win.location.href,
              updatedAt: Date.now(),
            })
          );
          return isStudyHeartbeatOwner(
            readStudyHeartbeat(),
            state,
            heartbeatOwnerId
          );
        } catch (error) {
          warn('写入跨标签页播放心跳失败', error);
          return false;
        }
      };

      if (initialStudyState.currentCourse && !publishStudyHeartbeat()) return;
      controller.setTimer(() => publishStudyHeartbeat(), STUDY_HEARTBEAT_INTERVAL_MS, true);
      controller.listen(win, 'pagehide', clearStudyHeartbeat);

      const getPlayControlState = () => {
        const centerPlay = doc.querySelector('.d-play-btn');
        const button = doc.querySelector(
          '.d-player-control .d-control-tool > .d-tool-bar:first-child > .d-tool-item:first-child'
        );
        if (!centerPlay && !button) {
          return { button: null, visible: false, label: '', visualState: 'missing' };
        }
        const indicator = centerPlay || button;
        const style = win.getComputedStyle(indicator);
        const rect = indicator.getBoundingClientRect();
        const centerPlayVisible = isVisibleControlMetrics({
          width: rect.width,
          height: rect.height,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
        });
        const accessibleLabel = normalizeText(
          [
            centerPlay?.getAttribute('aria-label'),
            centerPlay?.getAttribute('title'),
            button?.getAttribute('aria-label'),
            button?.getAttribute('title'),
            button?.textContent,
          ]
            .filter(Boolean)
            .join(' ')
        );
        const label = normalizeText(
          [accessibleLabel, centerPlay?.className, button?.className].filter(Boolean).join(' ')
        );
        const pauseGlyph = button?.querySelector(
          '[class*="pause"], [aria-label*="暂停"], [title*="暂停"]'
        );
        const playGlyph = button?.querySelector(
          '[class*="play"], [aria-label*="播放"], [title*="播放"]'
        );
        const visualState = /暂停|pause/i.test(accessibleLabel) || pauseGlyph
          ? 'playing'
          : centerPlayVisible || /播放|play/i.test(accessibleLabel) || playGlyph
            ? 'paused'
            : 'unknown';
        return {
          button,
          visible: Boolean(button && centerPlayVisible),
          label,
          visualState,
        };
      };

      const samplePlayback = (player, now = Date.now()) => {
        if (!player) {
          return { health: playbackHealth, advanced: false, progressing: false, sourceChanged: false };
        }
        const result = observePlaybackProgress(playbackHealth, {
          sourceToken: getSourceToken(player),
          currentTime: player.currentTime,
          ended: player.ended,
          now,
        });
        playbackHealth = result.health;
        if (result.sourceChanged || result.progressing) {
          stallClock = createStallClock();
          rebindAttempted = false;
        }
        return result;
      };

      const logPlaybackSnapshot = (event, player, lesson, extra = {}) => {
        const state = readState();
        const control = getPlayControlState();
        log('播放快照：', {
          event,
          mode: state.mode,
          runId: state.runId,
          courseKey: state.currentCourse?.key || null,
          courseTitle: state.currentCourse?.title || null,
          lessonKey: lesson?.key || null,
          lessonTitle: lesson?.title || null,
          lessonIndex: lesson?.index ?? null,
          videoSource: getSourceToken(player) || null,
          currentTime: player ? safeNumber(player.currentTime, 0) : null,
          duration: player && Number.isFinite(player.duration) ? player.duration : null,
          ended: Boolean(player?.ended),
          paused: player?.paused ?? null,
          readyState: player?.readyState ?? null,
          progress: lesson ? lesson.progress : null,
          timeAdvancing: Boolean(
            playbackHealth.lastAdvancedAt &&
              Date.now() - playbackHealth.lastAdvancedAt <= PLAYBACK_HEALTH_WINDOW_MS
          ),
          playControlVisible: control.visible,
          playControlState: control.visualState,
          playControlLabel: control.label || null,
          ...extra,
        });
      };

      const cleanupPlayer = () => {
        if (!boundPlayer || !playerHandlers) return;
        Object.entries(playerHandlers).forEach(([type, handler]) =>
          boundPlayer.removeEventListener(type, handler)
        );
        boundPlayer = null;
        playerHandlers = null;
      };

      const persistCurrentLesson = (lesson, sourceToken) => {
        if (!ownsStudyState()) return;
        updateState((state) => {
          if (!ownsStudyState(state)) return;
          if (!state.currentCourse) return;
          state.currentCourse.lesson = {
            key: lesson.key,
            title: lesson.title,
            index: lesson.index,
            sourceToken,
          };
          state.mode = MODE.playing;
          state.lastActionAt = Date.now();
        });
      };

      const recoverCourse = (reason) => {
        if (recovering || controller.isDisposed()) return;
        if (!ownsStudyState()) return;
        const livePlayer = doc.querySelector(SELECTORS.video);
        const liveLesson = getLessonItems().find((item) => item.active);
        const playback = samplePlayback(livePlayer);
        if (livePlayer && !livePlayer.ended && playback.progressing) {
          logPlaybackSnapshot('recovery-suppressed-active-playback', livePlayer, liveLesson, {
            reason,
          });
          return;
        }
        recovering = true;
        const state = readState();
        const recoveryRunId = state.runId;
        const recovery = planRecovery(state.retry.count);
        if (recovery.action === 'block') {
          cleanupPlayer();
          blockRun(`${reason}；连续恢复 ${MAX_RETRY_ROUNDS} 轮仍未成功`);
          return;
        }
        const nextState = updateState((next) => {
          next.retry = {
            courseKey: next.currentCourse?.key || null,
            count: recovery.count,
            reason,
          };
          next.mode = recovery.action === 'reenter' ? MODE.retryCurrent : MODE.retrying;
          next.lastActionAt = Date.now();
        });
        cleanupPlayer();
        warn(`第 ${recovery.count} 轮恢复当前课程：`, reason);
        controller.setTimer(() => {
          if (!isCurrentRun(recoveryRunId)) return;
          if (recovery.action === 'reload') {
            win.location.reload();
          } else if (nextState.currentCourse?.returnUrl) {
            win.location.href = nextState.currentCourse.returnUrl;
          } else {
            blockRun('没有可返回的课程列表地址');
          }
        }, 1_500);
      };

      const tryPlay = (player) => {
        const state = readState();
        if (!ownsStudyState(state)) return;
        const playbackRunId = state.runId;
        const playback = samplePlayback(player);
        if (
          !player ||
          !state.enabled ||
          state.mode !== MODE.playing ||
          player.ended ||
          player.readyState < 2
        ) {
          return;
        }
        const now = Date.now();
        const control = getPlayControlState();
        const canUsePlayControl = now - lastPlayControlAt >= PLAY_CONTROL_RETRY_MS;
        let clickedPlayControl = false;
        if (
          canUsePlayControl &&
          shouldSyncPlayControl({
            controlVisible: control.visible,
            controlState: control.visualState,
            ended: player.ended,
            readyState: player.readyState,
          })
        ) {
          lastPlayControlAt = now;
          player.muted = true;
          player.volume = 0;
          control.button.click();
          clickedPlayControl = true;
          logPlaybackSnapshot(
            playback.progressing || !player.paused
              ? 'play-control-synced-with-active-video'
              : 'play-control-clicked',
            player,
            getLessonItems().find((item) => item.active)
          );
        }
        if (playback.progressing || !player.paused) return;
        if (!canUsePlayControl && !clickedPlayControl) return;
        if (!clickedPlayControl) lastPlayControlAt = now;
        player.muted = true;
        player.volume = 0;
        const attempt = player.play();
        if (attempt && typeof attempt.catch === 'function') {
          attempt.catch((error) => {
            if (!isCurrentRun(playbackRunId)) return;
            warn('播放请求暂未成功，将继续观察而不刷新页面：', error?.message || error);
          });
        }
      };

      const finishCourse = async () => {
        if (finishingCourse || !ownsStudyState()) return;
        const lessons = getLessonItems();
        const completedLessonCount = lessons.filter((lesson) => lesson.progress >= 100).length;
        if (!lessons.length || completedLessonCount < lessons.length) {
          recoverCourse('准备结束大课程时，仍有子章节未确认完成');
          return;
        }
        finishingCourse = true;
        const completedAt = Date.now();
        const state = updateState((next) => {
          const returnHandoffId = `${next.runId}|${next.currentCourse.key}|${completedAt}`;
          next.mode = MODE.returning;
          next.confirmStartedAt = 0;
          next.retry = { courseKey: null, count: 0, reason: null };
          next.externalStudyOwned = false;
          next.currentCourse.completionEvidence = {
            runId: next.runId,
            courseKey: next.currentCourse.key,
            lessonCount: lessons.length,
            completedLessonCount,
            allLessonsConfirmedAt: completedAt,
            returnHandoffId,
            lastListReloadAt: 0,
            listReloadCount: 0,
          };
          next.lastActionAt = completedAt;
        });
        cleanupPlayer();
        const returnUrl = state.currentCourse?.returnUrl;
        if (!returnUrl) {
          blockRun('大课程已完成，但没有保存课程列表地址');
          return;
        }
        logPlaybackSnapshot(
          'course-lessons-complete',
          doc.querySelector(SELECTORS.video),
          getLessonItems().find((item) => item.active)
        );
        log('大课程内全部子视频已完成，等待在学课程列表确认接管');
        try {
          const ack = await waitUntil(() => {
            const currentState = readState();
            if (!isStudyOwnershipCurrent(currentState, state.runId, state.currentCourse.key)) {
              return null;
            }
            const candidate = readListReturnAck();
            return isFreshListReturnAck(candidate, currentState) ? candidate : null;
          }, controller, LIST_RETURN_ACK_TIMEOUT_MS);
          if (!isCurrentRun(state.runId)) return;
          if (planCourseReturn({ listAckFresh: true }) !== 'close-study-tab') return;
          log('在学课程列表已确认接管，关闭当前播放标签页：', {
            courseKey: state.currentCourse.key,
            handoffId: ack.handoffId,
            listUrl: ack.href,
          });
          clearStudyHeartbeat();
          try {
            if (win.opener && !win.opener.closed) win.opener.focus();
          } catch (_error) {
            // 浏览器可能使用 noopener 打开课程页，关闭标签页仍然有效。
          }
          win.close();
          controller.setTimer(() => {
            if (!isCurrentRun(state.runId)) return;
            warn('浏览器未允许自动关闭播放标签页；已确认在学课程列表正在继续，可手动关闭本页');
          }, 1_000);
        } catch (_error) {
          if (!isCurrentRun(state.runId)) return;
          if (planCourseReturn({ listAckFresh: false }) !== 'navigate-current-tab') return;
          clearStudyHeartbeat();
          warn('未收到在学课程列表接管确认；保留当前标签并直接返回列表继续下一门课程');
          if (typeof win.location.replace === 'function') {
            win.location.replace(returnUrl);
          } else {
            win.location.href = returnUrl;
          }
        }
      };

      const bindPlayer = (player, lesson) => {
        if (!player || !lesson) return;
        if (boundPlayer !== player) cleanupPlayer();
        expectedLessonKey = lesson.key;
        const source = getSourceToken(player);
        if (source) expectedSourceToken = source;
        persistCurrentLesson(lesson, expectedSourceToken);

        if (boundPlayer === player && playerHandlers) {
          tryPlay(player);
          return;
        }

        boundPlayer = player;
        playerHandlers = {
          loadeddata: () => {
            if (readState().mode !== MODE.playing) return;
            samplePlayback(player);
            const active = getLessonItems().find((item) => item.active);
            if (active && active.key === expectedLessonKey) {
              const currentSource = getSourceToken(player);
              if (currentSource) expectedSourceToken = currentSource;
              persistCurrentLesson(active, expectedSourceToken);
              tryPlay(player);
            }
          },
          pause: () => {
            samplePlayback(player);
            if (!player.ended && readState().mode === MODE.playing) {
              controller.setTimer(() => tryPlay(player), 700);
            }
          },
          play: () => samplePlayback(player),
          playing: () => {
            samplePlayback(player);
            logPlaybackSnapshot(
              'player-playing',
              player,
              getLessonItems().find((item) => item.active)
            );
          },
          timeupdate: () => samplePlayback(player),
          volumechange: () => {
            if (!player.muted || player.volume > 0) {
              player.muted = true;
              player.volume = 0;
            }
          },
          ended: () => confirmEnded(player, 'ended-event'),
          error: () => {
            samplePlayback(player);
            logPlaybackSnapshot(
              'player-error-observed',
              player,
              getLessonItems().find((item) => item.active),
              { error: player.error?.message || player.error?.code || 'unknown' }
            );
            controller.setTimer(() => tryPlay(player), 1_000);
          },
        };
        Object.entries(playerHandlers).forEach(([type, handler]) => player.addEventListener(type, handler));
        logPlaybackSnapshot('player-bound', player, lesson, {
          expectedSourceToken: expectedSourceToken || null,
        });
        tryPlay(player);
      };

      const switchLesson = async (target, oldSourceToken) => {
        if (!target || controller.isDisposed() || !ownsStudyState()) return;
        const switchRunId = readState().runId;
        playbackHealth = createPlaybackHealth();
        stallClock = createStallClock();
        rebindAttempted = false;
        missingPlayerSince = 0;
        updateState((state) => {
          state.mode = MODE.switching;
          state.lastActionAt = Date.now();
        });
        expectedLessonKey = target.key;
        logPlaybackSnapshot('lesson-switch-requested', doc.querySelector(SELECTORS.video), target, {
          previousSourceToken: oldSourceToken || null,
        });
        target.titleElement.click();
        try {
          const result = await waitUntil(() => {
            const lessons = getLessonItems();
            const active = lessons.find((item) => item.active);
            const player = doc.querySelector(SELECTORS.video);
            const sourceToken = getSourceToken(player);
            if (
              active?.key === target.key &&
              sourceToken &&
              sourceToken !== oldSourceToken &&
              player &&
              player.readyState >= 2
            ) {
              return { active, player, sourceToken };
            }
            return null;
          }, controller);
          if (!isCurrentRun(switchRunId)) return;
          expectedSourceToken = result.sourceToken;
          logPlaybackSnapshot('lesson-switch-confirmed', result.player, result.active, {
            previousSourceToken: oldSourceToken || null,
          });
          bindPlayer(result.player, result.active);
        } catch (error) {
          if (!isCurrentRun(switchRunId)) return;
          recoverCourse(`切换子视频失败：${target.title}`);
        }
      };

      const confirmEnded = async (player, reason) => {
        if (confirming || recovering || controller.isDisposed() || !ownsStudyState()) return;
        const confirmRunId = readState().runId;
        const lessons = getLessonItems();
        const active = lessons.find((item) => item.active);
        const sourceToken = getSourceToken(player);
        if (!active || active.key !== expectedLessonKey) {
          recoverCourse('播放器结束时活动目录项与预期不一致');
          return;
        }
        if (
          !hasVerifiedEndedSnapshot({
            ended: player.ended,
            currentTime: player.currentTime,
            duration: player.duration,
            sourceToken,
            expectedSourceToken,
          })
        ) {
          return;
        }
        const verifiedEnded = true;

        confirming = true;
        updateState((state) => {
          state.mode = MODE.confirming;
          state.confirmStartedAt = Date.now();
        });
        logPlaybackSnapshot('ended-confirming', player, active, {
          expectedSourceToken,
          trigger: reason,
        });
        log('检测到真实播放结束，等待目录进度确认：', active.title, reason);
        try {
          const completed = await waitUntil(() => {
            const current = getLessonItems().find((item) => item.key === active.key);
            if (!current) return null;
            return shouldConfirmLessonCompletion({
              verifiedEnded,
              progress: current.progress,
            })
              ? current
              : null;
          }, controller, COURSE_CONFIRM_TIMEOUT_MS);

          if (!isCurrentRun(confirmRunId)) return;

          updateState((state) => {
            state.retry = { courseKey: null, count: 0, reason: null };
            state.confirmStartedAt = 0;
          });
          logPlaybackSnapshot('ended-confirmed', player, completed, {
            expectedSourceToken,
            trigger: reason,
          });
          const refreshed = getLessonItems();
          const nextIndex = findNextIncompleteIndex(refreshed, completed.index, true);
          if (nextIndex == null) {
            confirming = false;
            finishCourse();
            return;
          }
          const next = refreshed[nextIndex];
          confirming = false;
          await switchLesson(next, sourceToken);
        } catch (error) {
          confirming = false;
          if (!isCurrentRun(confirmRunId)) return;
          recoverCourse(`子视频结束后进度未确认：${active.title}`);
        }
      };

      const initializeStudy = async () => {
        try {
          await Promise.all([
            waitForElement(SELECTORS.playlist, controller),
            waitForElement(SELECTORS.video, controller),
          ]);
          let state = readState();
          const courseTitle = normalizeText(doc.querySelector('.item1title')?.textContent) || '当前课程';
          if (!state.currentCourse) {
            const category = inferCurrentCategory(state);
            state.enabled = true;
            state.runId = newRunId();
            state.mode = MODE.manualStart;
            state.currentCategory = category;
            state.currentCourse = {
              key: `direct|${category.installId}|${courseTitle}`,
              title: courseTitle,
              installId: category.installId,
              page: 1,
              index: -1,
              href: '',
              returnUrl: doc.referrer.includes('/learningClassroom/ongoingTopicDetail')
                ? doc.referrer
                : category.href,
              confirmedComplete: false,
            };
            state.anchor = {
              categoryKey: category.key,
              categoryGroup: category.group,
              categoryOrder: category.sourceOrder,
              courseKey: state.currentCourse.key,
              courseTitle,
              page: 1,
              index: -1,
            };
            state.retry = { courseKey: state.currentCourse.key, count: 0, reason: null };
            writeState(state);
          }
          claimStudyOwnership(state);
          if (!state.enabled || state.mode === MODE.blocked || state.mode === MODE.paused) return;
          if (!publishStudyHeartbeat()) return;
          await new Promise((resolve) => controller.setTimer(resolve, STUDY_OWNERSHIP_SETTLE_MS));
          const settledState = readState();
          const settledHeartbeat = readStudyHeartbeat();
          if (
            !matchesStudyState(settledState) ||
            !isStudyHeartbeatOwner(settledHeartbeat, settledState, heartbeatOwnerId)
          ) {
            retireDuplicateStudyPage('播放所有权稳定确认失败', settledHeartbeat);
            return;
          }
          updateState((next) => {
            next.mode = MODE.playing;
            next.currentCourse.title = courseTitle;
            next.lastActionAt = Date.now();
          });
          publishStudyHeartbeat();

          const lessons = getLessonItems();
          if (!lessons.length) throw new Error('未找到子视频目录');
          const firstIncomplete = findFirstIncompleteIndex(lessons);
          if (firstIncomplete == null) {
            finishCourse();
            return;
          }
          const target = lessons[firstIncomplete];
          const active = lessons.find((item) => item.active);
          const player = doc.querySelector(SELECTORS.video);
          if (!active || active.key !== target.key) {
            await switchLesson(target, getSourceToken(player));
          } else {
            expectedSourceToken = getSourceToken(player);
            bindPlayer(player, active);
          }

          controller.observe(doc.querySelector(SELECTORS.playlist), { childList: true, subtree: true }, () => {
            const currentPlayer = doc.querySelector(SELECTORS.video);
            const currentLesson = getLessonItems().find((item) => item.active);
            if (currentPlayer && currentLesson && readState().mode === MODE.playing) {
              bindPlayer(currentPlayer, currentLesson);
            }
          });
          const playerWrap = doc.getElementById('dPlayerVideo') || doc.getElementById('refPlayerWrap');
          controller.observe(playerWrap, { childList: true, subtree: true }, () => {
            const currentPlayer = doc.querySelector(SELECTORS.video);
            const currentLesson = getLessonItems().find((item) => item.active);
            if (currentPlayer && currentLesson && readState().mode === MODE.playing) {
              bindPlayer(currentPlayer, currentLesson);
            }
          });
          controller.setTimer(() => {
            const currentState = readState();
            if (
              !ownsStudyState(currentState) ||
              !currentState.enabled ||
              currentState.mode !== MODE.playing ||
              recovering ||
              confirming
            ) {
              return;
            }
            const now = Date.now();
            const currentPlayer = doc.querySelector(SELECTORS.video);
            if (!currentPlayer) {
              if (!missingPlayerSince) missingPlayerSince = now;
              if (now - missingPlayerSince >= PLAYER_MISSING_GRACE_MS) {
                recoverCourse(`播放器节点连续缺失 ${PLAYER_MISSING_GRACE_MS / 1_000} 秒`);
              }
              return;
            }
            missingPlayerSince = 0;
            const playback = samplePlayback(currentPlayer, now);
            if (currentPlayer.ended) {
              confirmEnded(currentPlayer, 'ended-poll');
              return;
            }
            if (playback.progressing) {
              tryPlay(currentPlayer);
              return;
            }
            stallClock = observeStallClock(stallClock, { progressing: false, now });
            tryPlay(currentPlayer);
            const stalledFor = stallClock.accumulatedMs;
            const currentLesson = getLessonItems().find((item) => item.active);
            if (stalledFor >= PLAYER_REBIND_AFTER_MS && !rebindAttempted) {
              rebindAttempted = true;
              logPlaybackSnapshot('player-rebind-before-refresh', currentPlayer, currentLesson, {
                stalledForMs: stalledFor,
              });
              cleanupPlayer();
              if (currentLesson) bindPlayer(currentPlayer, currentLesson);
              tryPlay(currentPlayer);
              return;
            }
            if (stalledFor >= PLAYER_RELOAD_AFTER_MS) {
              recoverCourse(`视频时间连续 ${Math.round(stalledFor / 1_000)} 秒没有前进`);
            }
          }, PLAYER_INTERVAL_MS, true);
        } catch (error) {
          recoverCourse(error.message || String(error));
        }
      };

      initializeStudy();
      controller.listen(doc, 'visibilitychange', () => {
        if (!doc.hidden) tryPlay(doc.querySelector(SELECTORS.video));
      });
      controller.listen(win, 'focus', () => tryPlay(doc.querySelector(SELECTORS.video)));
      const originalDispose = controller.dispose;
      controller.dispose = () => {
        cleanupPlayer();
        clearStudyHeartbeat();
        originalDispose();
      };
    };

    const routeName = () => {
      const path = win.location.pathname;
      if (path.startsWith('/study')) return 'study';
      if (path.startsWith('/learningClassroom/ongoingTopicDetail')) return 'detail';
      if (path.startsWith('/learningClassroom/ongoingTopic')) return 'topic';
      return 'other';
    };

    const mountRoute = (force = false) => {
      const nextRoute = routeName();
      if (!force && nextRoute === mountedRoute) return;
      if (routeController) routeController.dispose();
      routeController = createController();
      mountedRoute = nextRoute;
      if (nextRoute === 'study') mountStudyRoute(routeController);
      else if (nextRoute === 'detail') mountDetailRoute(routeController);
      else if (nextRoute === 'topic') mountTopicRoute(routeController);
    };

    win.startCourseMarathon = () => {
      const state = updateState((next) => {
        next.enabled = true;
        next.runId = next.runId || newRunId();
        next.externalStudyOwned = false;
        if (next.mode === MODE.blocked || next.mode === MODE.paused) {
          next.mode = next.currentCourse ? MODE.retryCurrent : MODE.idle;
          next.retry = {
            courseKey: next.currentCourse?.key || null,
            count: 0,
            reason: null,
          };
        }
        next.lastActionAt = Date.now();
      });
      log(
        state.anchor
          ? `自动连播已开启，起点：${state.anchor.courseTitle}`
          : '自动连播已开启；请手动进入一门大课程以设置起点'
      );
      mountRoute(true);
    };

    win.stopCourseMarathon = () => {
      updateState((state) => {
        state.enabled = false;
        state.mode = MODE.paused;
        state.runId = newRunId();
        state.externalStudyOwned = false;
        state.lastActionAt = Date.now();
      });
      if (routeController) routeController.dispose();
      log('自动连播已暂停，所有等待和跳转任务已取消');
    };

    win.resetCourseMarathonState = () => {
      const state = createDefaultState();
      state.enabled = false;
      state.mode = MODE.paused;
      writeState(state);
      clearListReturnAck();
      if (routeController) routeController.dispose();
      log('自动连播状态已清空；请手动选择新的起点');
    };

    win.getCourseMarathonStatus = () => {
      const state = readState();
      console.table({
        enabled: state.enabled,
        mode: state.mode,
        category: state.currentCategory?.title || state.currentCategory?.group || '',
        anchor: state.anchor?.courseTitle || '',
        course: state.currentCourse?.title || '',
        retryCount: state.retry.count,
        retryReason: state.retry.reason || '',
        externalStudyOwned: state.externalStudyOwned,
      });
      return state;
    };

    mountRoute();
    win.setInterval(() => mountRoute(false), 1_000);
    log('单脚本状态机已启动；手动进入大课程即可重设播放起点');
  }

  return {
    MODE,
    STATE_VERSION,
    MAX_RETRY_ROUNDS,
    clampProgress,
    createDefaultState,
    migrateState,
    makeCourseKey,
    makeLessonKey,
    findFirstIncompleteIndex,
    findNextIncompleteIndex,
    selectFollowingCourse,
    orderCategoryEntries,
    selectNextCategoryEntry,
    shouldAcceptEnded,
    hasVerifiedEndedSnapshot,
    shouldConfirmLessonCompletion,
    createPlaybackHealth,
    createStallClock,
    observePlaybackProgress,
    observeStallClock,
    planRecovery,
    classifyCategoryGroup,
    applyManualStart,
    hasConfirmedCourseCompletion,
    isFreshStudyHeartbeat,
    planStudyHeartbeat,
    isStudyHeartbeatOwner,
    isFreshCourseLaunchLease,
    isFreshListReturnAck,
    planCourseReturn,
    isStudyOwnershipCurrent,
    shouldSyncPlayControl,
    isVisibleControlMetrics,
    run,
  };
});


'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODE,
  STATE_VERSION,
  clampProgress,
  migrateState,
  makeCourseKey,
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
} = require('../SQGJ 自动连播.user.js');

test('旧版状态迁移时保留当前课程和返回地址', () => {
  const state = migrateState({
    enabled: true,
    activeInstallId: 'annual-1',
    installs: {
      'annual-1': {
        mode: 'course',
        currentCourse: '示例课程',
        returnUrl: 'https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail?installId=annual-1',
      },
    },
  });

  assert.equal(state.version, STATE_VERSION);
  assert.equal(state.mode, MODE.playing);
  assert.equal(state.currentCourse.title, '示例课程');
  assert.match(state.currentCourse.returnUrl, /installId=annual-1/);
});

test('从任意中间课程起点只选择其后的未完成课程', () => {
  const courses = [
    { key: 'a', title: '课程一', index: 0, progress: 30 },
    { key: 'b', title: '课程二', index: 1, progress: 100 },
    { key: 'c', title: '课程三', index: 2, progress: 20 },
  ];
  assert.equal(selectFollowingCourse(courses, courses[0]).key, 'c');
  assert.equal(selectFollowingCourse(courses, courses[2]), null);
});

test('从第一个课程开始时按页面顺序向下', () => {
  const courses = [
    { key: 'first', title: '第一课', index: 0, progress: 0 },
    { key: 'second', title: '第二课', index: 1, progress: 0 },
  ];
  assert.equal(selectFollowingCourse(courses, courses[0]).key, 'second');
});

test('已完成课程从在学列表消失后，从它原来的索引位置继续', () => {
  const shiftedCourses = [
    { key: 'second', title: '第二课', index: 0, progress: 0 },
    { key: 'third', title: '第三课', index: 1, progress: 0 },
  ];
  const removedCourse = { key: 'first', title: '第一课', index: 0, progress: 100 };
  assert.equal(
    selectFollowingCourse(shiftedCourses, removedCourse, { currentRemoved: true }).key,
    'second'
  );
});

test('页面中间课程消失时不会跳过补到原位置的下一门', () => {
  const shiftedCourses = [
    { key: 'first', title: '第一课', index: 0, progress: 100 },
    { key: 'third', title: '第三课', index: 1, progress: 20 },
    { key: 'fourth', title: '第四课', index: 2, progress: 0 },
  ];
  const removedCourse = { key: 'second', title: '第二课', index: 1, progress: 100 };
  assert.equal(
    selectFollowingCourse(shiftedCourses, removedCourse, { currentRemoved: true }).key,
    'third'
  );
});

test('再次手动选择课程时替换旧起点、旧课程和旧运行批次', () => {
  const previous = migrateState({
    runId: 'old-run',
    mode: MODE.playing,
    anchor: { courseKey: 'old-course', courseTitle: '旧课程' },
    currentCourse: { key: 'old-course', title: '旧课程' },
    retry: { courseKey: 'old-course', count: 2, reason: '旧错误' },
  });
  const category = {
    key: 'special|s1',
    group: 'special',
    sourceOrder: 3,
    installId: 's1',
  };
  const course = {
    key: 'new-course',
    title: '新课程',
    installId: 's1',
    page: 2,
    index: 4,
    returnUrl: 'https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail?installId=s1',
  };

  const next = applyManualStart(previous, {
    category,
    course,
    runId: 'new-run',
    timestamp: 123,
  });

  assert.equal(next.runId, 'new-run');
  assert.equal(next.mode, MODE.manualStart);
  assert.equal(next.anchor.courseKey, 'new-course');
  assert.equal(next.currentCourse.title, '新课程');
  assert.deepEqual(next.retry, { courseKey: 'new-course', count: 0, reason: null });
  assert.equal(next.lastActionAt, 123);
});

test('子视频先找第一个未完成项并可回绕补漏', () => {
  const lessons = [
    { progress: 50 },
    { progress: 100 },
    { progress: 20 },
  ];
  assert.equal(findFirstIncompleteIndex(lessons), 0);
  assert.equal(findNextIncompleteIndex(lessons, 0), 2);
  assert.equal(findNextIncompleteIndex(lessons, 2), 0);
});

test('全部子视频完成后不再选择下一项', () => {
  const lessons = [{ progress: 100 }, { progress: 100 }];
  assert.equal(findFirstIncompleteIndex(lessons), null);
  assert.equal(findNextIncompleteIndex(lessons, 1), null);
});

test('暂停、缓冲或进度未确认不能被当作播放结束', () => {
  const base = {
    ended: true,
    currentTime: 99.5,
    duration: 100,
    sourceToken: 'video-a',
    expectedSourceToken: 'video-a',
    progress: 100,
  };
  assert.equal(shouldAcceptEnded(base), true);
  assert.equal(shouldAcceptEnded({ ...base, ended: false }), false);
  assert.equal(shouldAcceptEnded({ ...base, currentTime: 70 }), false);
  assert.equal(shouldAcceptEnded({ ...base, progress: 99 }), false);
  assert.equal(shouldAcceptEnded({ ...base, sourceToken: 'video-b' }), false);
});

test('播放器节点复用时仍要求视频源发生并保持一致', () => {
  assert.equal(
    shouldAcceptEnded({
      ended: true,
      currentTime: 120,
      duration: 120,
      sourceToken: 'new-source',
      expectedSourceToken: 'old-source',
      progress: 100,
    }),
    false
  );
});

test('真实 ended 快照确认后，播放器重建不会抹掉等待目录进度的证据', () => {
  const verifiedEnded = hasVerifiedEndedSnapshot({
    ended: true,
    currentTime: 100,
    duration: 100,
    sourceToken: 'video-a',
    expectedSourceToken: 'video-a',
  });
  assert.equal(verifiedEnded, true);
  assert.equal(shouldConfirmLessonCompletion({ verifiedEnded, progress: 99 }), false);
  assert.equal(shouldConfirmLessonCompletion({ verifiedEnded, progress: 100 }), true);
  assert.equal(shouldConfirmLessonCompletion({ verifiedEnded: false, progress: 100 }), false);
});

test('视频时间持续前进时始终判定为健康播放，不依赖按钮或 paused 显示', () => {
  let health = createPlaybackHealth();
  let sample = observePlaybackProgress(health, {
    sourceToken: 'video-a',
    currentTime: 20,
    now: 1_000,
  });
  assert.equal(sample.progressing, false);

  sample = observePlaybackProgress(sample.health, {
    sourceToken: 'video-a',
    currentTime: 21.5,
    now: 2_500,
  });
  assert.equal(sample.advanced, true);
  assert.equal(sample.progressing, true);

  sample = observePlaybackProgress(sample.health, {
    sourceToken: 'video-a',
    currentTime: 21.5,
    now: 8_000,
  });
  assert.equal(sample.progressing, true);

  sample = observePlaybackProgress(sample.health, {
    sourceToken: 'video-a',
    currentTime: 21.5,
    now: 13_001,
  });
  assert.equal(sample.progressing, false);
});

test('播放器换源或时间倒退时清空旧视频的健康播放证据', () => {
  const oldHealth = {
    sourceToken: 'video-a',
    lastTime: 50,
    lastObservedAt: 2_000,
    lastAdvancedAt: 2_000,
  };
  const changed = observePlaybackProgress(oldHealth, {
    sourceToken: 'video-b',
    currentTime: 0,
    now: 3_000,
  });
  assert.equal(changed.sourceChanged, true);
  assert.equal(changed.progressing, false);
  assert.equal(changed.health.lastAdvancedAt, 0);

  const rewound = observePlaybackProgress(oldHealth, {
    sourceToken: 'video-a',
    currentTime: 10,
    now: 3_000,
  });
  assert.equal(rewound.progressing, false);
  assert.equal(rewound.health.lastAdvancedAt, 0);
});

test('恢复策略前两轮刷新、第三轮重进、第四次阻塞', () => {
  assert.deepEqual(planRecovery(0), { count: 1, action: 'reload' });
  assert.deepEqual(planRecovery(1), { count: 2, action: 'reload' });
  assert.deepEqual(planRecovery(2), { count: 3, action: 'reenter' });
  assert.deepEqual(planRecovery(3), { count: 4, action: 'block' });
});

test('分类固定为年度网络自学课程后接专题培训', () => {
  const ordered = orderCategoryEntries([
    { key: 'special', group: 'special', sourceOrder: 0 },
    { key: 'annual-2', group: 'annual', sourceOrder: 2 },
    { key: 'annual-1', group: 'annual', sourceOrder: 1 },
  ]);
  assert.deepEqual(ordered.map((entry) => entry.key), ['annual-1', 'annual-2', 'special']);
  assert.equal(classifyCategoryGroup('年度网络自学课程'), 'annual');
  assert.equal(classifyCategoryGroup('网络自学'), 'annual');
  assert.equal(classifyCategoryGroup('2026年度网络自学'), 'annual');
  assert.equal(classifyCategoryGroup('专题培训分类'), 'special');
});

test('跨分类只从当前分类之后继续，无法定位时安全停止', () => {
  const entries = orderCategoryEntries([
    { key: 'annual-1', installId: 'a1', group: 'annual', groupRank: 0, sourceOrder: 0 },
    { key: 'annual-2', installId: 'a2', group: 'annual', groupRank: 0, sourceOrder: 1 },
    { key: 'special-1', installId: 's1', group: 'special', groupRank: 1, sourceOrder: 0 },
  ]);
  assert.equal(selectNextCategoryEntry(entries, entries[0]).entry.key, 'annual-2');
  assert.equal(selectNextCategoryEntry(entries, entries[2]).status, 'complete');
  assert.equal(
    selectNextCategoryEntry(entries, { key: 'missing', installId: 'x', group: 'annual' }).status,
    'unresolved'
  );
});

test('课程标识包含分类、分页、位置和标题', () => {
  const key = makeCourseKey({
    installId: 'special-1',
    page: 2,
    index: 3,
    title: ' 课程名称 ',
    href: 'https://www.sqgj.gov.cn/study?id=1',
  });
  assert.match(key, /^special-1\|2\|3\|\/study\?id=1\|课程名称$/);
});

test('进度值被约束在 0 到 100', () => {
  assert.equal(clampProgress(-2), 0);
  assert.equal(clampProgress(120), 100);
  assert.equal(clampProgress('75'), 75);
  assert.equal(clampProgress('bad'), 0);
});

test('只有同一运行批次和课程的完整子章节证据才能确认课程移出在学列表', () => {
  const state = migrateState({
    runId: 'run-1',
    currentCourse: {
      key: 'course-1',
      title: '课程一',
      completionEvidence: {
        runId: 'run-1',
        courseKey: 'course-1',
        lessonCount: 3,
        completedLessonCount: 3,
        allLessonsConfirmedAt: 10_000,
      },
    },
  });
  assert.equal(hasConfirmedCourseCompletion(state), true);
  assert.equal(
    hasConfirmedCourseCompletion({
      ...state,
      currentCourse: {
        ...state.currentCourse,
        completionEvidence: { ...state.currentCourse.completionEvidence, completedLessonCount: 2 },
      },
    }),
    false
  );
  assert.equal(hasConfirmedCourseCompletion({ ...state, runId: 'run-2' }), false);
  assert.equal(
    hasConfirmedCourseCompletion({
      ...state,
      currentCourse: { ...state.currentCourse, completionEvidence: null },
    }),
    false
  );
});

test('跨标签页心跳必须匹配运行批次和课程且仍在有效期内', () => {
  const state = migrateState({
    runId: 'run-1',
    currentCourse: { key: 'course-1', title: '课程一' },
  });
  const heartbeat = { runId: 'run-1', courseKey: 'course-1', updatedAt: 10_000 };
  assert.equal(isFreshStudyHeartbeat(heartbeat, state, 15_999), true);
  assert.equal(isFreshStudyHeartbeat(heartbeat, state, 16_001), false);
  assert.equal(isFreshStudyHeartbeat({ ...heartbeat, runId: 'run-2' }, state, 11_000), false);
  assert.equal(
    isFreshStudyHeartbeat({ ...heartbeat, courseKey: 'course-2' }, state, 11_000),
    false
  );
});

test('同一课程的播放心跳是排他的，后到标签必须让出所有权', () => {
  const state = migrateState({
    enabled: true,
    runId: 'run-1',
    currentCourse: { key: 'course-1', title: '课程一' },
  });
  const heartbeat = {
    ownerId: 'tab-a',
    runId: 'run-1',
    courseKey: 'course-1',
    updatedAt: 10_000,
  };

  assert.equal(
    planStudyHeartbeat({ heartbeat, state, ownerId: 'tab-a', now: 11_000 }),
    'renew'
  );
  assert.equal(isStudyHeartbeatOwner(heartbeat, state, 'tab-a', 11_000), true);
  assert.equal(
    planStudyHeartbeat({ heartbeat, state, ownerId: 'tab-b', now: 11_000 }),
    'yield'
  );
  assert.equal(isStudyHeartbeatOwner(heartbeat, state, 'tab-b', 11_000), false);
});

test('旧心跳失效后允许新的播放页接管', () => {
  const state = migrateState({
    enabled: true,
    runId: 'run-1',
    currentCourse: { key: 'course-1', title: '课程一' },
  });
  const stale = {
    ownerId: 'tab-a',
    runId: 'run-1',
    courseKey: 'course-1',
    updatedAt: 10_000,
  };
  assert.equal(
    planStudyHeartbeat({ heartbeat: stale, state, ownerId: 'tab-b', now: 16_001 }),
    'claim'
  );
});

test('同一运行批次和课程的打开租约在有效期内阻止重复点击', () => {
  const state = migrateState({
    enabled: true,
    runId: 'run-1',
    currentCourse: { key: 'course-1', title: '课程一' },
  });
  const lease = {
    ownerId: 'list-a',
    launchId: 'launch-1',
    runId: 'run-1',
    courseKey: 'course-1',
    updatedAt: 10_000,
  };
  assert.equal(isFreshCourseLaunchLease(lease, state, 'course-1', 54_999), true);
  assert.equal(isFreshCourseLaunchLease(lease, state, 'course-1', 55_001), false);
  assert.equal(isFreshCourseLaunchLease({ ...lease, runId: 'run-2' }, state, 'course-1', 11_000), false);
  assert.equal(isFreshCourseLaunchLease(lease, state, 'course-2', 11_000), false);
});

test('播放页只有收到同一完成交接的列表确认后才允许关闭', () => {
  const state = migrateState({
    runId: 'run-1',
    mode: MODE.returning,
    currentCourse: {
      key: 'course-1',
      title: '课程一',
      completionEvidence: {
        runId: 'run-1',
        courseKey: 'course-1',
        lessonCount: 4,
        completedLessonCount: 4,
        allLessonsConfirmedAt: 10_000,
        returnHandoffId: 'handoff-1',
      },
    },
  });
  const ack = {
    runId: 'run-1',
    courseKey: 'course-1',
    handoffId: 'handoff-1',
    updatedAt: 10_500,
  };

  assert.equal(isFreshListReturnAck(ack, state, 11_000), true);
  assert.equal(planCourseReturn({ listAckFresh: true }), 'close-study-tab');
  assert.equal(isFreshListReturnAck({ ...ack, runId: 'run-2' }, state, 11_000), false);
  assert.equal(isFreshListReturnAck({ ...ack, courseKey: 'course-2' }, state, 11_000), false);
  assert.equal(isFreshListReturnAck({ ...ack, handoffId: 'old-handoff' }, state, 11_000), false);
  assert.equal(isFreshListReturnAck({ ...ack, updatedAt: 9_999 }, state, 11_000), false);
  assert.equal(isFreshListReturnAck(ack, state, 25_501), false);
});

test('没有列表页接管确认时保留播放标签并在原标签返回课程列表', () => {
  assert.equal(planCourseReturn({ listAckFresh: false }), 'navigate-current-tab');
});

test('旧播放标签页不能接管手动重选后的新运行批次', () => {
  const original = migrateState({
    enabled: true,
    runId: 'run-1',
    currentCourse: { key: 'course-1', title: '课程一' },
  });
  assert.equal(isStudyOwnershipCurrent(original, 'run-1', 'course-1'), true);

  const manuallyReselected = migrateState({
    enabled: true,
    runId: 'run-2',
    currentCourse: { key: 'course-2', title: '课程二' },
  });
  assert.equal(isStudyOwnershipCurrent(manuallyReselected, 'run-1', 'course-1'), false);
  assert.equal(isStudyOwnershipCurrent(manuallyReselected, 'run-2', 'course-2'), true);
});

test('视频已在前进但中央仍是三角形时允许同步播放器按钮状态', () => {
  const visiblePlay = {
    controlVisible: true,
    controlState: 'paused',
    ended: false,
    readyState: 4,
  };
  assert.equal(shouldSyncPlayControl(visiblePlay), true);
  assert.equal(shouldSyncPlayControl({ ...visiblePlay, controlVisible: false }), false);
  assert.equal(shouldSyncPlayControl({ ...visiblePlay, controlState: 'playing' }), false);
  assert.equal(shouldSyncPlayControl({ ...visiblePlay, ended: true }), false);
  assert.equal(shouldSyncPlayControl({ ...visiblePlay, readyState: 1 }), false);
});

test('固定定位的播放按钮不能只因 offsetParent 为空就判定不可见', () => {
  assert.equal(
    isVisibleControlMetrics({
      width: 60,
      height: 60,
      display: 'flex',
      visibility: 'visible',
      opacity: '1',
    }),
    true
  );
  assert.equal(
    isVisibleControlMetrics({
      width: 60,
      height: 60,
      display: 'none',
      visibility: 'visible',
      opacity: '1',
    }),
    false
  );
});

test('后台计时器长时间未调度不会被累计成连续视频停滞', () => {
  let clock = createStallClock();
  clock = observeStallClock(clock, { progressing: false, now: 1_000 });
  clock = observeStallClock(clock, { progressing: false, now: 2_500 });
  clock = observeStallClock(clock, { progressing: false, now: 4_000 });
  assert.equal(clock.accumulatedMs, 3_000);

  clock = observeStallClock(clock, { progressing: false, now: 84_000 });
  assert.equal(clock.accumulatedMs, 0);
  assert.equal(clock.lastSampleAt, 84_000);

  clock = observeStallClock(clock, { progressing: false, now: 85_500 });
  assert.equal(clock.accumulatedMs, 1_500);
  clock = observeStallClock(clock, { progressing: true, now: 86_000 });
  assert.deepEqual(clock, { accumulatedMs: 0, lastSampleAt: 86_000 });
});


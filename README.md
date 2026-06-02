<p align="center">
  <a href="#中文">中文</a> | <a href="#english">English</a>
</p>

---

<h1 id="中文">陕西网络干部学院课程连播脚本</h1>

这是一个适用于陕西网络干部学院（`sqgj.gov.cn`）的 Tampermonkey / Violentmonkey 用户脚本项目。项目包含两个脚本，配合实现课程列表自动进入未完成课程、课程页静音连播、播放完成后返回列表并继续处理下一门课程。

> 本项目仅用于个人学习辅助与技术交流。使用前请确认符合所在单位、平台规则及相关法律法规；因使用脚本产生的任何后果由使用者自行承担。

## 功能

- 自动识别课程列表中进度未满 100% 的课程。
- 自动点击"继续学习"或"开始学习"。
- 课程页自动静音播放。
- 单个课程内自动切换下一节未完成内容。
- 当前课程完成后自动返回原课程列表。
- 支持列表分页，会继续查找下一页未完成课程。
- 支持同一站点不同 `installId` 的课程列表独立记录状态。

## 文件说明

| 文件 | 作用 | 匹配页面 |
| --- | --- | --- |
| `SQGJ 列表轮播 (1).user.js` | 在课程列表页查找未完成课程并进入学习 | `https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail*` |
| `SQGJ 课程连播 (1).user.js` | 在课程播放页自动播放、切换小节并返回列表 | `https://www.sqgj.gov.cn/study*` |

两个脚本需要同时安装，单独安装其中一个无法完成完整流程。

## 安装

1. 安装浏览器用户脚本管理器：
   - Chrome / Edge 推荐使用 [Tampermonkey](https://www.tampermonkey.net/)
   - 也可以使用 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开本仓库中的脚本文件。
3. 点击 GitHub 页面右上方的 `Raw`。
4. 用户脚本管理器会自动弹出安装页面，点击安装。
5. 对下面两个文件都执行一次安装：
   - `SQGJ 列表轮播 (1).user.js`
   - `SQGJ 课程连播 (1).user.js`

安装完成后，脚本管理器中应能看到 `SQGJ 列表轮播` 和 `SQGJ 课程连播` 两个脚本。

## 使用方法

1. 登录陕西网络干部学院。
2. 进入专题或课程列表页，页面地址通常类似：

   ```text
   https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail...
   ```

3. 保持当前标签页打开，脚本会自动从第一个未完成课程开始处理。
4. 进入课程播放页后，脚本会静音播放当前课程内容，并在完成后自动返回列表。
5. 如果列表当前页没有未完成课程，脚本会尝试翻到下一页继续查找。

## 控制命令

在课程列表页打开浏览器开发者工具 Console，可以手动执行以下命令：

```js
startCourseMarathon()
```

开启或恢复自动轮播。

```js
stopCourseMarathon()
```

暂停自动轮播。

```js
resetCourseMarathonState()
```

清空当前 `installId` 的脚本状态。遇到状态异常、重复进入同一课程时可以尝试执行。

## 状态存储

脚本使用浏览器 `sessionStorage` 记录当前列表、课程和播放状态。状态只在当前浏览器会话中有效，关闭浏览器或清理站点数据后会重置。

## 注意事项

- 请保持课程页面所在标签页打开，避免浏览器挂起后台标签页导致播放中断。
- 部分浏览器会限制自动播放，脚本已尝试通过静音播放和点击播放区域处理，但仍可能需要首次手动点击一次播放按钮。
- 如果平台页面结构更新，脚本可能失效，需要更新选择器或逻辑。
- 脚本不绕过登录、验证码、权限校验或平台接口限制。
- 建议先在少量课程上测试，确认行为符合预期后再长时间使用。

## 常见问题

### 安装后没有自动运行怎么办？

确认是否同时安装了两个脚本，并检查当前页面地址是否匹配脚本支持的地址。也可以刷新页面后再试。

### 播放完成后没有返回列表怎么办？

可能是页面结构变化、视频结束事件没有触发，或浏览器阻止了页面跳转。可以刷新页面，或回到列表页执行：

```js
resetCourseMarathonState()
startCourseMarathon()
```

### 如何确认脚本正在工作？

打开开发者工具 Console，可以看到以 `[SQGJ 列表]` 或 `[SQGJ 课程]` 开头的日志。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

---

<h1 id="english">Shaanxi Online Cadre Academy — Course Marathon Scripts</h1>

This is a Tampermonkey / Violentmonkey userscript project for the Shaanxi Online Cadre Academy (`sqgj.gov.cn`). It includes two scripts that work together to automatically enter unfinished courses from the course list, play through courses silently and continuously, return to the list after completion, and move on to the next course.

> This project is for personal learning assistance and technical exchange only. Please ensure compliance with your institution's rules, platform policies, and applicable laws. The user assumes all responsibility for any consequences arising from the use of these scripts.

## Features

- Automatically identifies courses with less than 100% progress in the course list.
- Automatically clicks "Continue Learning" or "Start Learning".
- Auto-plays course content in muted mode.
- Automatically switches to the next unfinished section within a course.
- Returns to the original course list after completing a course.
- Supports pagination — continues searching for unfinished courses on the next page.
- Independent state tracking for course lists with different `installId` values.

## File Overview

| File | Purpose | URL Match |
| --- | --- | --- |
| `SQGJ 列表轮播 (1).user.js` | Finds unfinished courses in the list and enters them | `https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail*` |
| `SQGJ 课程连播 (1).user.js` | Auto-plays, switches sections, and returns to the list on the course player page | `https://www.sqgj.gov.cn/study*` |

Both scripts must be installed together; installing only one will not complete the full workflow.

## Installation

1. Install a browser userscript manager:
   - [Tampermonkey](https://www.tampermonkey.net/) (recommended for Chrome / Edge)
   - Or [Violentmonkey](https://violentmonkey.github.io/)
2. Open the script files in this repository.
3. Click the `Raw` button at the top right of the GitHub page.
4. Your userscript manager will automatically prompt you to install — click **Install**.
5. Install both scripts:
   - `SQGJ 列表轮播 (1).user.js`
   - `SQGJ 课程连播 (1).user.js`

After installation, you should see both `SQGJ 列表轮播` and `SQGJ 课程连播` in your userscript manager.

## Usage

1. Log in to the Shaanxi Online Cadre Academy.
2. Navigate to a topic or course list page (URL typically looks like):

   ```text
   https://www.sqgj.gov.cn/learningClassroom/ongoingTopicDetail...
   ```

3. Keep the tab open — the script will automatically start processing from the first unfinished course.
4. On the course player page, the script will play content silently and automatically return to the list upon completion.
5. If the current list page has no unfinished courses, the script will attempt to navigate to the next page.

## Console Commands

Open the browser Developer Tools Console on the course list page to run these commands:

```js
startCourseMarathon()
```

Start or resume the auto-loop.

```js
stopCourseMarathon()
```

Pause the auto-loop.

```js
resetCourseMarathonState()
```

Clear the script state for the current `installId`. Useful when encountering state errors or repeatedly entering the same course.

## State Storage

The scripts use the browser's `sessionStorage` to track current list, course, and playback state. State is only valid within the current browser session and resets when the browser is closed or site data is cleared.

## Notes

- Keep the course page tab open to avoid the browser suspending background tabs and interrupting playback.
- Some browsers restrict autoplay. The scripts attempt to handle this via muted playback and simulated clicks on the play area, but you may still need to manually click the play button once the first time.
- If the platform's page structure is updated, the scripts may break and require selector or logic updates.
- These scripts do NOT bypass login, CAPTCHAs, permission checks, or platform API restrictions.
- It is recommended to test on a small number of courses first before extended use.

## FAQ

### The script doesn't run after installation?

Make sure both scripts are installed and the current page URL matches the supported patterns. Try refreshing the page.

### The script doesn't return to the list after playback finishes?

This could be due to page structure changes, the video end event not firing, or the browser blocking navigation. Try refreshing the page, or go back to the list page and run:

```js
resetCourseMarathonState()
startCourseMarathon()
```

### How do I know the script is working?

Open the Developer Tools Console — you should see log messages prefixed with `[SQGJ 列表]` or `[SQGJ 课程]`.

## License

This project is open source under the [MIT License](LICENSE).

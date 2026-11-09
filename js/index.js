(function () {
	'use strict';

	var stage = document.getElementById('stage');
	var stageBox = document.getElementById('stageBox');
	var player = null;
	var vars = { nvzhuName: '女主', jinglingName: '路琪', nanzhuName: '苏子轩' };

	var lastW = 0;
	var lastH = 0;
	function fit() {
		// 以舞台实际渲染尺寸为准, 实时适配
		var w = stage.clientWidth || window.innerWidth;
		var h = stage.clientHeight || window.innerHeight;
		if (!w || !h) return;
		if (w === lastW && h === lastH && player) return;
		lastW = w;
		lastH = h;
		var s = Math.min(w / 800, h / 600);
		var box = document.getElementById('stageBox');
		box.style.width = (800 * s) + 'px';
		box.style.height = (600 * s) + 'px';
		if (player) {
			player.root.style.transform = 'scale(' + s + ')';
			var ratio = s * (window.devicePixelRatio || 1);
			var cv = player.canvas;
			if (Math.abs(cv.width - 800 * ratio) > 1) {
				cv.width = Math.round(800 * ratio);
				cv.height = Math.round(600 * ratio);
				player.drawRatio = ratio;
			}
		}
	}
	// 播放期间持续监视尺寸变化(进/退全屏、转屏都是异步生效)
	setInterval(fit, 300);
	window.addEventListener('resize', fit);
	document.addEventListener('fullscreenchange', fit);
	document.addEventListener('webkitfullscreenchange', fit);

	function closeStage() {
		if (player) {
			player.stop();
			player.destroy();
			player = null;
		}
		stage.style.display = 'none';
		if (document.fullscreenElement) document.exitFullscreen();
	}
	document.getElementById('closeBtn').onclick = closeStage;

	var loadOverlay = document.getElementById('loadOverlay');
	var loadText = document.getElementById('loadText');

	function showOverlay(text) {
		loadText.textContent = text;
		loadOverlay.style.display = 'block';
	}

	function hideOverlay() {
		loadOverlay.style.display = 'none';
	}

	// 预载关卡引用的全部资源, 流式统计速度, 结果以blob url塞进env.resources
	function preloadLevel(data, onProgress) {
		var env = { assets: window.GAME_ASSETS || { imgs: {}, snds: {} }, resources: data.resources || {} };
		var needed = {};
		(data.exps || []).forEach(function (e) {
			var p = e.para || {};
			if ((e.key === 'setLayer' || e.key === 'moveLayer') && p.img) {
				var u = GAoEngine.resolveSrc(p.img, 'img', env);
				if (u && u.indexOf('data:') !== 0) needed[u] = { kind: 'img', name: p.img }; // base64内嵌的已在env里, 不用拉
			} else if (e.key === 'playSound' && p.snd) {
				var u2 = GAoEngine.resolveSrc(p.snd, 'snd', env);
				if (u2 && u2.indexOf('data:') !== 0) needed[u2] = { kind: 'snd', name: p.snd };
			}
		});
		var urls = Object.keys(needed);
		var done = 0;
		var bytes = 0;
		var t0 = Date.now();

		function report() {
			var secs = Math.max(0.2, (Date.now() - t0) / 1000);
			onProgress(done, urls.length, Math.round(bytes / 1024 / secs));
		}
		report();
		if (!urls.length) return Promise.resolve(env);

		return Promise.all(urls.map(function (u) {
			return fetch(u).then(function (res) {
				if (!res.ok) throw new Error('资源 ' + res.status);
				var mime = res.headers.get('content-type') || (needed[u].kind === 'img' ? 'image/png' : 'audio/mpeg');
				if (!res.body) return res.blob().then(function (b) {
					env.resources[needed[u].name] = { type: needed[u].kind, data: URL.createObjectURL(b) };
					done++;
					report();
				});
				var reader = res.body.getReader();
				var chunks = [];
				function pump() {
					return reader.read().then(function (r) {
						if (r.done) {
							env.resources[needed[u].name] = {
								type: needed[u].kind,
								data: URL.createObjectURL(new Blob(chunks, { type: mime }))
							};
							done++;
							report();
							return null;
						}
						chunks.push(r.value);
						bytes += r.value.length;
						report();
						return pump();
					});
				}
				return pump();
			});
		})).then(function () { return env; });
	}

	function play(src) {
		showOverlay('加载关卡中...');
		fetch(src).then(function (r) { return r.json(); }).then(function (data) {
			showOverlay('加载资源中... 0/0 0 KB/s');
			return preloadLevel(data, function (done, total, kbps) {
				loadText.textContent = '加载资源中... ' + done + '/' + total + ' ' + kbps + ' KB/s';
			}).then(function (env) {
				hideOverlay();
				if (player) player.destroy();
				stage.style.display = 'flex';
				lastW = 0; // 强制重新适配
				fit();
				player = GAoEngine.create(stageBox, {
					assets: env.assets,
					resources: env.resources,
					vars: vars
				});
				fit();
				// 与编辑器一致: 全屏 + 手机锁横屏
				var fn = stage.requestFullscreen || stage.webkitRequestFullscreen;
				if (fn) {
					var p = fn.call(stage);
					if (p && p.then) {
						p.then(function () {
							if (screen.orientation && screen.orientation.lock) {
								screen.orientation.lock('landscape').catch(function () {});
							}
						}).catch(function () {});
					}
				}
				player.play(data.exps, 0, null);
			});
		}).catch(function (e) {
			hideOverlay();
			alert('关卡加载失败: ' + e.message);
		});
	}

	// 纯静态清单: 各目录下的 list.js, script标签加载
	function renderList(ulId, base, list, fan) {
		var ul = document.getElementById(ulId);
		ul.textContent = '';
		if (!list || !list.length) {
			ul.textContent = fan ? '（暂无玩家自制关卡）' : '（没有找到关卡文件）';
			return;
		}
		// 条目: "xxx.json" 或 {file, title, author, date}; 标题在清单里, 不用再拉JSON
		var entries = list.map(function (e) {
			if (typeof e === 'string') return { file: e, title: '', author: '', date: '' };
			return { file: e.file, title: e.title || '', author: e.author || '', date: e.date || '' };
		});
		entries.sort(function (a, b) { return a.title < b.title ? -1 : 1; });
		entries.forEach(function (en) {
			var src = base.replace(/\/$/, '') + '/' + en.file;
			var li = document.createElement('li');
			var a = document.createElement('a');
			a.href = 'javascript:void(0)';
			a.textContent = en.title || en.file.replace(/\.json$/i, '');
			a.onclick = function () { play(src); };
			li.appendChild(a);
			if (fan) {
				var sp = document.createElement('span');
				sp.textContent = '（' + en.author + '）';
				li.appendChild(sp);
			}
			if (en.date) {
				var dt = document.createElement('span');
				dt.textContent = ' ' + en.date;
				li.appendChild(dt);
			}
			var dl = document.createElement('a');
			dl.href = src;
			dl.setAttribute('download', '');
			dl.textContent = ' [下载JSON]';
			li.appendChild(dl);
			ul.appendChild(li);
		});
	}

	function loadManifest(listSrc, ulId, base, fan) {
		var s = document.createElement('script');
		s.src = listSrc;
		s.onload = function () {
			renderList(ulId, base, (window.SCRIPT_LIST || []), fan);
			window.SCRIPT_LIST = null;
		};
		s.onerror = function () {
			renderList(ulId, base, [], fan);
		};
		document.head.appendChild(s);
	}

	loadManifest('assets/script/list.js', 'offiList', 'assets/script', false);
	loadManifest('assets/script/fanmade/list.js', 'fanList', 'assets/script/fanmade', true);

	// 玩家自制穿搭清单, 点击跳到服装编辑器预览
	function renderDressList(list) {
		var ul = document.getElementById('dressFanList');
		ul.textContent = '';
		if (!list || !list.length) {
			ul.textContent = '（暂无玩家自制穿搭）';
			return;
		}
		list.forEach(function (en) {
			var file = typeof en === 'string' ? en : en.file;
			var li = document.createElement('li');
			var a = document.createElement('a');
			a.href = 'dress?fan=' + encodeURIComponent(file);
			a.textContent = (en.title || file.replace(/\.json$/i, ''));
			li.appendChild(a);
			if (en.author) {
				var sp = document.createElement('span');
				sp.textContent = '（' + en.author + '）';
				li.appendChild(sp);
			}
			if (en.date) {
				var dt = document.createElement('span');
				dt.textContent = ' ' + en.date;
				li.appendChild(dt);
			}
			var dl = document.createElement('a');
			dl.href = 'assets/dress/fanmade/' + file;
			dl.setAttribute('download', '');
			dl.textContent = ' [下载JSON]';
			li.appendChild(dl);
			ul.appendChild(li);
		});
	}

	function loadDressList() {
		var s = document.createElement('script');
		s.src = 'assets/dress/fanmade/list.js';
		s.onload = function () {
			renderDressList(window.DRESS_LIST || []);
			window.DRESS_LIST = null;
		};
		s.onerror = function () {
			renderDressList([]);
		};
		document.head.appendChild(s);
	}

	loadDressList();
})();

(function () {
	'use strict';

	document.addEventListener('contextmenu', function (e) {
		e.preventDefault();
	});

	var story = { des: '新剧情', script: 'new001' };
	var nodes = [];
	var vars = { nvzhuName: '女主', jinglingName: '路琪', nanzhuName: '苏子轩' };
	var resources = {}; // name -> {type, data:dataURL}
	var sel = -1;
	var uid = 1;
	var compiled = null; // {exps, ranges}, ranges是每个节点对应的exp区间

	var CAT_NAMES = {
		'bg': '背景',
		'cg/CG': 'CG',
		'chara/nvzhu': '女主·睡衣',
		'chara/nvzhu/gongshi': '女主',
		'chara/jingling': '精灵',
		'chara/suzixuan': '苏子轩',
		'chara/yifeng': '逸风',
		'chara/NPC': 'NPC'
	};

	function $(id) { return document.getElementById(id); }
	var stageWrap = $('stageWrap');
	var stageBox = $('stageBox');
	var nodeListEl = $('nodeList');
	var propsEl = $('props');

	var player = GAoEngine.create(stageBox, {
		assets: window.GAME_ASSETS || { imgs: {}, snds: {} },
		resources: resources,
		vars: vars
	});

	var stageScale = 1;
	function fitStage() {
		// 手机端舞台占满首屏剩余高度, 画布贴边不留缝
		var mobile = window.innerWidth <= 900;
		if (mobile) {
			var th = $('topbar').offsetHeight || 40;
			stageWrap.style.height = Math.max(240, window.innerHeight - th) + 'px';
		} else if (stageWrap.style.height) {
			stageWrap.style.height = '';
		}
		var pad = mobile ? 0 : 20;
		var w = stageWrap.clientWidth - pad;
		var h = stageWrap.clientHeight - pad;
		if (w <= 0 || h <= 0) return;
		// 全屏时允许放大铺满, 平时最大1:1
		var cap = document.fullscreenElement || document.webkitFullscreenElement ? 100 : 1;
		stageScale = Math.min(cap, w / GAoEngine.STAGE_W, h / GAoEngine.STAGE_H);
		player.root.style.transform = 'scale(' + stageScale + ')';
		stageBox.style.width = (GAoEngine.STAGE_W * stageScale) + 'px';
		stageBox.style.height = (GAoEngine.STAGE_H * stageScale) + 'px';
		// canvas 内部分辨率跟上, 放大不糊
		var ratio = stageScale * (window.devicePixelRatio || 1);
		var cv = player.canvas;
		if (Math.abs(cv.width - GAoEngine.STAGE_W * ratio) > 1) {
			cv.width = Math.round(GAoEngine.STAGE_W * ratio);
			cv.height = Math.round(GAoEngine.STAGE_H * ratio);
			player.drawRatio = ratio;
		}
	}
	window.addEventListener('resize', fitStage);

	var undoStack = [];
	var redoStack = [];
	var lastPush = 0;

	function snapshot() {
		return JSON.stringify({ des: story.des, script: story.script, nodes: nodes });
	}

	function pushHistory() {
		var now = Date.now();
		// 滑块拖动太快, 400ms内算同一次改动
		if (now - lastPush < 400 && undoStack.length) {
			lastPush = now;
			return;
		}
		undoStack.push(snapshot());
		if (undoStack.length > 50) undoStack.shift();
		redoStack = [];
		lastPush = now;
		updateUndoBtns();
	}

	function restore(snap) {
		var o = JSON.parse(snap);
		story.des = o.des;
		story.script = o.script;
		nodes = o.nodes;
		$('metaDes').value = story.des;
		$('metaScript').value = story.script;
		sel = Math.min(sel, nodes.length - 1);
		lastPush = 0;
		renderAll();
	}

	function doUndo() {
		if (player.running) stopPlay();
		if (!undoStack.length) return;
		redoStack.push(snapshot());
		restore(undoStack.pop());
		updateUndoBtns();
	}

	function doRedo() {
		if (player.running) stopPlay();
		if (!redoStack.length) return;
		undoStack.push(snapshot());
		restore(redoStack.pop());
		updateUndoBtns();
	}

	function updateUndoBtns() {
		$('btnUndo').disabled = !undoStack.length;
		$('btnRedo').disabled = !redoStack.length;
	}

	$('btnUndo').onclick = doUndo;
	$('btnRedo').onclick = doRedo;

	function cz(s) { return { key: 'tag', para: { cz: s } }; }
	function tagE(name) { return { key: 'tag', para: { tag: name } }; }

	function collectLabels() {
		var used = {};
		nodes.forEach(function (n) {
			(n.labels || []).forEach(function (l) { used[l] = true; });
		});
		return used;
	}

	function newLabel(used) {
		var i = 1;
		while (used['tag_' + i]) i++;
		var name = 'tag_' + i;
		used[name] = true;
		return name;
	}

	function imgPara(n, alpha) {
		return {
			img: n.img, mirrow: !!n.mirror, layer: n.layer, bright: n.bright,
			alpha: alpha, trans: n.trans != false, y: n.y, scaleX: n.scaleX, scaleY: n.scaleY, x: n.x
		};
	}

	function compile() {
		var exps = [];
		var ranges = [];
		var used = collectLabels();
		var layerImg = {}; // 每层当前是什么图, 用来判断要不要输出setLayer
		var nodeTag = {}; // 节点uid -> 跳转标签名

		function ensureTag(n) {
			if (!nodeTag[n.uid]) {
				if (n.labels && n.labels.length) nodeTag[n.uid] = n.labels[0];
				else {
					var l = newLabel(used);
					n.labels = [l];
					nodeTag[n.uid] = l;
				}
			}
			return nodeTag[n.uid];
		}

		// 目标节点可能在选项前面, 标签得先分好
		nodes.forEach(function (n) {
			if (n.type == 'option') {
				(n.options || []).forEach(function (o) {
					var t = nodes.filter(function (x) { return x.uid == o.target; })[0];
					if (t) ensureTag(t);
				});
			} else if (n.type == 'jump') {
				var t2 = nodes.filter(function (x) { return x.uid == n.target; })[0];
				if (t2) ensureTag(t2);
			}
		});

		nodes.forEach(function (n, idx) {
			var start = exps.length;
			(n.labels || []).forEach(function (l) { exps.push(tagE(l)); });
			var isBg = n.type == 'bg';
			var layerName = isBg ? 'bg' : n.layer;
			var tt = n.transTime || 0;
			switch (n.type) {
				case 'bg':
				case 'chara':
					var changed = layerImg[layerName] !== n.img;
					if (n.hide) {
						exps.push(cz(isBg ? '前层背景消失' : '前层立绘消失'));
						var p0 = imgPara(n, 0);
						p0.transTime = tt;
						exps.push({ key: 'moveLayer', para: p0 });
						if (tt > 0) exps.push({ key: 'wait', para: { time: tt } });
					} else {
						exps.push(cz('特效'));
						exps.push(cz('音效'));
						exps.push(cz('前层立绘消失'));
						exps.push(cz('前层背景消失'));
						if (!isBg && n.bringFront) exps.push({ key: 'top', para: { layer: n.bringFront } });
						exps.push(cz(isBg ? '当前层背景出现' : '当前层立绘出现'));
						if (changed) {
							exps.push({ key: 'setLayer', para: imgPara(n, n.setAlpha != null ? n.setAlpha : 0) });
						}
						var pb = imgPara(n, n.alpha != null ? n.alpha : 1);
						pb.transTime = tt;
						exps.push({ key: 'moveLayer', para: pb });
						if (tt > 0) exps.push({ key: 'wait', para: { time: tt } });
					}
					// 原版hide并不卸图, 同图再出现不用重新setLayer
					layerImg[layerName] = n.img;
					break;
				case 'text':
					exps.push(cz('当前层立绘出现'));
					exps.push(cz('语音播放'));
					exps.push(cz('文字播放'));
					// chain: 上一句不清屏, 下一段直接接着显示
					var ending = n.chain ? '[l]' : '[l][hide][cm]';
					var txt = n.raw ? n.text : ('[show]' + n.text + ending);
					exps.push({
						key: 'text',
						para: { nameSide: n.nameSide || 'left', charaName: n.name || '', text: txt }
					});
					exps.push(cz('等待'));
					break;
				case 'sound':
					exps.push(cz('特效'));
					exps.push(cz('音效'));
					exps.push({
						key: 'playSound',
						para: { loop: !!n.loop, volume: n.volume, channel: n.channel || 'bgm', snd: n.snd }
					});
					break;
				case 'stopSound':
					exps.push({ key: 'stopSound', para: { channel: n.channel || 'bgm' } });
					break;
				case 'wait':
					exps.push(cz('等待'));
					if (n.click) exps.push({ key: 'wait', para: { type: 'click' } });
					else exps.push({ key: 'wait', para: { time: n.time || 0 } });
					break;
				case 'shake':
					exps.push({ key: 'shake', para: { x: n.x, y: n.y, d: n.d, layer: n.layer } });
					break;
				case 'flash':
					exps.push({ key: 'flash', para: { time: n.time, color: n.color, layer: n.layer } });
					break;
				case 'option':
					var opts = (n.options || []).map(function (o) {
						var t = nodes.filter(function (x) { return x.uid == o.target; })[0];
						return { text: o.text, tag: t ? ensureTag(t) : 'tag_1' };
					});
					exps.push({ key: 'option', para: { options: opts } });
					break;
				case 'jump':
					var t2 = nodes.filter(function (x) { return x.uid == n.target; })[0];
					exps.push({ key: 'jump', para: { tag: t2 ? ensureTag(t2) : (n.tag || 'tag_1') } });
					break;
				case 'end':
					exps.push({ key: 'end' });
					break;
				default:
					if (n.exp) exps.push(n.exp);
					break;
			}
			ranges[idx] = [start, exps.length];
		});
		compiled = { exps: exps, ranges: ranges };
		return compiled;
	}

	function imgNodeType(layer) {
		return layer == 'bg' ? 'bg' : 'chara';
	}

	function decompile(exps) {
		var out = [];
		var pendingLabels = [];
		var pendingTop = null;
		var lastSet = null; // 刚setLayer还没moveLayer的节点

		function push(n) {
			n.uid = uid++;
			n.labels = pendingLabels;
			pendingLabels = [];
			// top挂在立绘上有意义, 背景随便
			if (pendingTop && n.type == 'chara') {
				n.bringFront = pendingTop;
				pendingTop = null;
			}
			out.push(n);
			return n;
		}

		exps.forEach(function (e) {
			var p = e.para || {};
			switch (e.key) {
				case 'tag':
					if (p.tag) pendingLabels.push(p.tag);
					break;
				case 'top':
					pendingTop = p.layer;
					break;
				case 'setLayer':
					lastSet = push({
						type: imgNodeType(p.layer), layer: p.layer, img: p.img,
						x: p.x, y: p.y, scaleX: p.scaleX, scaleY: p.scaleY,
						mirror: !!p.mirrow, bright: p.bright != null ? p.bright : 1,
						alpha: p.alpha, transTime: 0, trans: p.trans != false, hide: false,
						setAlpha: Number(p.alpha) > 0 ? p.alpha : null
					});
					break;
				case 'moveLayer':
					var n = null;
					if (lastSet && lastSet.layer == p.layer) {
						n = lastSet;
						lastSet = null;
					} else {
						n = push({
							type: imgNodeType(p.layer), layer: p.layer, img: p.img,
							x: p.x, y: p.y, scaleX: p.scaleX, scaleY: p.scaleY,
							mirror: !!p.mirrow, bright: p.bright != null ? p.bright : 1,
							alpha: p.alpha, transTime: p.transTime || 0, hide: false
						});
					}
					n.img = p.img;
					n.x = p.x; n.y = p.y;
					n.scaleX = p.scaleX; n.scaleY = p.scaleY;
					n.mirror = !!p.mirrow;
					n.bright = p.bright != null ? p.bright : 1;
					n.transTime = p.transTime || 0;
					n.trans = p.trans != false;
					n.hide = (p.alpha == 0);
					n.alpha = p.alpha;
					break;
				case 'wait':
					if (p.type == 'click') {
						push({ type: 'wait', click: true });
					} else {
						var t = parseInt(p.time) || 0;
						var last = out[out.length - 1];
						if (last && (last.type == 'bg' || last.type == 'chara') &&
							t == last.transTime && !last._wait) {
							last._wait = true; // 跟过渡配套的wait直接并进去
						} else if (t > 0) {
							push({ type: 'wait', time: t });
						}
					}
					break;
				case 'text':
					var txt = p.text || '';
					var raw = true;
					var chain = false;
					var m = txt.match(/^\[show\]([\s\S]*)\[l\]\[hide\]\[cm\]$/);
					if (m) {
						txt = m[1];
						raw = false;
					} else {
						var m2 = txt.match(/^\[show\]([\s\S]*)\[l\]$/);
						if (m2) {
							txt = m2[1];
							raw = false;
							chain = true; // 只到[l]就结束, 说明下一段是接着显示的
						}
					}
					push({
						type: 'text', name: p.charaName || '',
						nameSide: p.nameSide == 'right' ? 'right' : 'left',
						text: txt, raw: raw, chain: chain
					});
					break;
				case 'playSound':
					push({ type: 'sound', snd: p.snd, volume: p.volume, loop: !!p.loop, channel: p.channel || 'bgm' });
					break;
				case 'stopSound':
					push({ type: 'stopSound', channel: p.channel || 'bgm' });
					break;
				case 'setSoundVolume':
					push({ type: 'raw', exp: e });
					break;
				case 'option':
					push({
						type: 'option',
						options: (p.options || []).map(function (o) { return { text: o.text, tag: o.tag }; })
					});
					break;
				case 'jump':
					push({ type: 'jump', tag: p.tag, target: null });
					break;
				case 'end':
					push({ type: 'end' });
					break;
				case 'flash':
					push({ type: 'flash', time: p.time, color: p.color, layer: p.layer });
					break;
				case 'shake':
					push({ type: 'shake', x: p.x, y: p.y, d: p.d, layer: p.layer });
					break;
				case 'para':
				case 'event':
					push({ type: 'raw', exp: e });
					break;
				default:
					push({ type: 'raw', exp: e });
					break;
			}
		});
		// 标签换算回目标节点
		out.forEach(function (n) {
			if (n.type == 'jump' && n.tag) {
				var t = findNodeByLabel(out, n.tag);
				if (t) { n.target = t.uid; n.tag = null; }
			}
			if (n.type == 'option') {
				(n.options || []).forEach(function (o) {
					var t2 = findNodeByLabel(out, o.tag);
					if (t2) { o.target = t2.uid; o.tag = null; }
				});
			}
		});
		out.forEach(function (n) { delete n._wait; });
		return out;
	}

	function findNodeByLabel(list, label) {
		for (var i = 0; i < list.length; i++) {
			if (list[i].labels && list[i].labels.indexOf(label) >= 0) return list[i];
		}
		return null;
	}

	function catName(cat) {
		return CAT_NAMES[cat] || cat;
	}

	function fillImgSelect(selEl, cur) {
		selEl.innerHTML = '';
		var groups = {};
		var A = window.GAME_ASSETS || { imgs: {} };
		Object.keys(A.imgs).forEach(function (name) {
			var it = A.imgs[name];
			if (!groups[it.cat]) groups[it.cat] = [];
			groups[it.cat].push(name);
		});
		Object.keys(groups).forEach(function (cat) {
			var og = document.createElement('optgroup');
			og.label = catName(cat);
			groups[cat].sort().forEach(function (name) {
				var o = document.createElement('option');
				o.value = name;
				o.textContent = name;
				og.appendChild(o);
			});
			selEl.appendChild(og);
		});
		var custom = Object.keys(resources).filter(function (k) { return resources[k].type == 'img'; });
		if (custom.length) {
			var og2 = document.createElement('optgroup');
			og2.label = '自定义';
			custom.forEach(function (name) {
				var o = document.createElement('option');
				o.value = name;
				o.textContent = name;
				og2.appendChild(o);
			});
			selEl.appendChild(og2);
		}
		if (cur && !selEl.querySelector('option[value="' + cur + '"]')) {
			var o3 = document.createElement('option');
			o3.value = cur;
			o3.textContent = cur + ' (缺失)';
			selEl.appendChild(o3);
		}
		selEl.value = cur || '';
	}

	function fillSndSelect(selEl, cur) {
		selEl.innerHTML = '';
		var og = document.createElement('optgroup');
		og.label = '音乐';
		var A = window.GAME_ASSETS || { snds: {} };
		Object.keys(A.snds).sort().forEach(function (name) {
			var o = document.createElement('option');
			o.value = name;
			o.textContent = name;
			og.appendChild(o);
		});
		selEl.appendChild(og);
		var custom = Object.keys(resources).filter(function (k) { return resources[k].type == 'snd'; });
		if (custom.length) {
			var og2 = document.createElement('optgroup');
			og2.label = '自定义';
			custom.forEach(function (name) {
				var o = document.createElement('option');
				o.value = name;
				o.textContent = name;
				og2.appendChild(o);
			});
			selEl.appendChild(og2);
		}
		if (cur && !selEl.querySelector('option[value="' + cur + '"]')) {
			var o3 = document.createElement('option');
			o3.value = cur;
			o3.textContent = cur + ' (缺失)';
			selEl.appendChild(o3);
		}
		selEl.value = cur || '';
	}

	function el(tag, cls, parent) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (parent) parent.appendChild(e);
		return e;
	}

	function field(label, control, parent) {
		var row = el('div', 'field', parent);
		var lb = el('label', 'flabel', row);
		lb.textContent = label;
		row.appendChild(control);
		return row;
	}

	function mkInput(type, value, onch) {
		var i = document.createElement('input');
		i.type = type;
		i.value = value != null ? value : '';
		i.onchange = function () { pushHistory(); onch(i); refresh(); };
		return i;
	}

	function mkCheck(text, value, onch) {
		var lb = document.createElement('label');
		lb.className = 'ckline';
		var i = document.createElement('input');
		i.type = 'checkbox';
		i.checked = !!value;
		i.onchange = function () { pushHistory(); onch(i.checked); refresh(); };
		lb.appendChild(i);
		lb.appendChild(document.createTextNode(' ' + text));
		return lb;
	}

	function mkRange(min, max, step, value, onch, fmt) {
		var box = document.createElement('span');
		box.className = 'rangebox';
		var i = document.createElement('input');
		i.type = 'range';
		i.min = min; i.max = max; i.step = step;
		i.value = value;
		var v = document.createElement('span');
		v.className = 'rangeval';
		v.textContent = fmt ? fmt(value) : value;
		i.oninput = function () {
			v.textContent = fmt ? fmt(i.value) : i.value;
			pushHistory();
			onch(parseFloat(i.value));
			refresh();
		};
		box.appendChild(i);
		box.appendChild(v);
		return box;
	}

	function mkSelect(onch) {
		var s = document.createElement('select');
		s.onchange = function () { pushHistory(); onch(s.value); refresh(); };
		return s;
	}

	function curNode() { return nodes[sel] || null; }

	function renderProps() {
		propsEl.innerHTML = '';
		stopSndPreview();
		var n = curNode();
		if (!n) {
			propsEl.innerHTML = '<div class="tip">选中左侧节点进行编辑</div>';
			return;
		}
		var head = el('div', 'phead', propsEl);
		head.textContent = typeName(n) + '  #' + (sel + 1);

		// 上移/下移/删除
		var ops = el('div', 'pops', propsEl);
		var bUp = el('button', '', ops); bUp.textContent = '上移';
		bUp.onclick = function () { if (sel > 0) { pushHistory(); nodes.splice(sel, 1); nodes.splice(sel - 1, 0, n); sel--; renderAll(); } };
		var bDn = el('button', '', ops); bDn.textContent = '下移';
		bDn.onclick = function () { if (sel < nodes.length - 1) { pushHistory(); nodes.splice(sel, 1); nodes.splice(sel + 1, 0, n); sel++; renderAll(); } };
		var bDel = el('button', '', ops); bDel.textContent = '删除';
		bDel.onclick = function () { pushHistory(); nodes.splice(sel, 1); sel = Math.min(sel, nodes.length - 1); renderAll(); };

		switch (n.type) {
			case 'bg':
			case 'chara':
				renderImgProps(n);
				break;
			case 'text':
				renderTextProps(n);
				break;
			case 'sound':
				var s1 = mkSelect(function (v) { n.snd = v; });
				fillSndSelect(s1, n.snd);
				field('音乐', s1, propsEl);
				field('音量', mkRange(0, 1, 0.05, n.volume, function (v) { n.volume = v; }), propsEl);
				propsEl.appendChild(mkCheck('循环播放', n.loop, function (v) { n.loop = v; }));
				var pv = el('button', '', propsEl);
				pv.id = 'sndPvBtn';
				pv.textContent = '试听';
				pv.onclick = function () { toggleSndPreview(n.snd); };
				break;
			case 'stopSound':
				break;
			case 'wait':
				field('毫秒', mkInput('number', n.time, function (i) { n.time = parseInt(i.value) || 0; }), propsEl);
				break;
			case 'shake':
				var sl = mkSelect(function (v) { n.layer = v; });
				['bg', 'chara1', 'chara2', 'chara3', 'fore', 'dialog'].forEach(function (l) {
					var o = document.createElement('option'); o.value = l; o.textContent = l; sl.appendChild(o);
				});
				sl.value = n.layer || 'bg';
				field('目标', sl, propsEl);
				field('横向强度', mkInput('number', n.x, function (i) { n.x = parseInt(i.value) || 0; }), propsEl);
				field('纵向强度', mkInput('number', n.y, function (i) { n.y = parseInt(i.value) || 0; }), propsEl);
				field('衰减', mkRange(0.5, 0.95, 0.05, n.d, function (v) { n.d = v; }), propsEl);
				break;
			case 'flash':
				var fl = mkSelect(function (v) { n.layer = v; });
				['bg', 'chara1', 'chara2', 'chara3', 'fore', 'dialog'].forEach(function (l) {
					var o = document.createElement('option'); o.value = l; o.textContent = l; fl.appendChild(o);
				});
				fl.value = n.layer || 'bg';
				field('目标', fl, propsEl);
				var ci = document.createElement('input');
				ci.type = 'color';
				ci.value = '#' + String(n.color || 'ffffff').replace('#', '');
				ci.onchange = function () { n.color = ci.value.replace('#', ''); refresh(); };
				field('颜色', ci, propsEl);
				field('时长', mkRange(0, 2000, 50, n.time, function (v) { n.time = v; }), propsEl);
				break;
			case 'option':
				renderOptionProps(n);
				break;
			case 'jump':
				renderJumpProps(n);
				break;
			case 'end':
				el('div', 'tip', propsEl).textContent = '剧情到此结束';
				break;
			default:
				var ta = document.createElement('textarea');
				ta.value = JSON.stringify(n.exp);
				ta.onchange = function () {
					try { n.exp = JSON.parse(ta.value); refresh(); }
					catch (e) { alert('JSON 格式有误'); }
				};
				propsEl.appendChild(ta);
				break;
		}
	}

	// 按图片实际尺寸适配位置: 背景居中, 立绘底部居中
	function autoFit(n) {
		var src = GAoEngine.resolveSrc(n.img, 'img', {
			assets: window.GAME_ASSETS || { imgs: {} },
			resources: resources
		});
		if (!src) return;
		var im = new Image();
		im.onload = function () {
			if (n.type == 'bg') {
				n.x = Math.round((800 - im.naturalWidth) / 2);
				n.y = Math.round((600 - im.naturalHeight) / 2);
			} else {
				n.x = Math.round((800 - im.naturalWidth) / 2);
				n.y = 600 - im.naturalHeight;
			}
			refresh();
		};
		im.src = src;
	}

	function renderImgProps(n) {
		var isBg = n.type == 'bg';
		if (!isBg) {
			var ls = mkSelect(function (v) { n.layer = v; });
			['chara1', 'chara2', 'chara3'].forEach(function (l) {
				var o = document.createElement('option'); o.value = l; o.textContent = l; ls.appendChild(o);
			});
			ls.value = n.layer || 'chara1';
			field('层', ls, propsEl);
		}
		var isel = mkSelect(function (v) {
			n.img = v;
			if (isBg) autoFit(n); // 换背景自动居中, 免得非1000x600的图错位
		});
		fillImgSelect(isel, n.img);
		field('图片', isel, propsEl);

		var fitBtn = el('button', '', propsEl);
		fitBtn.textContent = isBg ? '自适应居中' : '底部居中';
		fitBtn.style.marginBottom = '6px';
		fitBtn.onclick = function () { pushHistory(); autoFit(n); };

		var xy = el('div', 'xyrow', propsEl);
		var xl = el('label', '', xy); xl.textContent = 'X';
		var xi = mkInput('number', Math.round(n.x), function (i) { n.x = parseInt(i.value) || 0; });
		xi.className = 'xyin'; xi.id = 'propX';
		xy.appendChild(xi);
		var yl = el('label', '', xy); yl.textContent = 'Y';
		var yi = mkInput('number', Math.round(n.y), function (i) { n.y = parseInt(i.value) || 0; });
		yi.className = 'xyin'; yi.id = 'propY';
		xy.appendChild(yi);
		if (!isBg) {
			var hint = el('span', 'xyhint', xy);
			hint.textContent = '可在舞台上拖拽';
		} else {
			var hint2 = el('span', 'xyhint', xy);
			hint2.textContent = '可在舞台上拖拽';
		}

		field('缩放', mkRange(0.2, 2, 0.05, n.scaleX, function (v) { n.scaleX = v; n.scaleY = v; }), propsEl);
		propsEl.appendChild(mkCheck('镜像', n.mirror, function (v) { n.mirror = v; }));
		field('亮度', mkRange(0.3, 1.5, 0.05, n.bright, function (v) { n.bright = v; }), propsEl);
		field('过渡', mkRange(0, 1500, 50, n.transTime, function (v) { n.transTime = v; }), propsEl);
		propsEl.appendChild(mkCheck('隐藏该层图片', n.hide, function (v) { n.hide = v; }));
	}

	function renderTextProps(n) {
		var nameIn = mkInput('text', n.name, function (i) { n.name = i.value; });
		var who = mkSelect(function (v) {
			if (v == '__custom') {
				n.name = '';
				nameIn.value = '';
			} else {
				n.name = v;
				nameIn.value = v;
			}
			nameIn.disabled = (v != '__custom');
		});
		[['{nvzhuName}', '女主'], ['{jinglingName}', '精灵'], ['{nanzhuName}', '男主']].forEach(function (p) {
			var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; who.appendChild(o);
		});
		var oc = document.createElement('option'); oc.value = '__custom'; oc.textContent = '自定义'; who.appendChild(oc);
		who.value = ['{nvzhuName}', '{jinglingName}', '{nanzhuName}'].indexOf(n.name) >= 0 ? n.name : '__custom';
		nameIn.disabled = (who.value != '__custom');
		field('说话人', who, propsEl);

		field('名字', nameIn, propsEl);

		var side = el('div', 'siderow', propsEl);
		var r1 = mkCheck('左', n.nameSide != 'right', function (v) { if (v) n.nameSide = 'left'; refresh(); });
		var r2 = mkCheck('右', n.nameSide == 'right', function (v) { if (v) n.nameSide = 'right'; refresh(); });
		side.appendChild(r1); side.appendChild(r2);

		var tagwrap = el('div', 'tagwrap', propsEl);
		var tl = el('label', 'flabel', tagwrap);
		tl.textContent = '内容';
		var tagbox = el('div', 'tagbox', tagwrap);
		[['换行', '[r]', ''], ['等点击', '[l]', ''], ['停顿', '[wait=500]', ''],
			['红色', '[color=ff0000]', '[colorEnd]'], ['大字', '[size=30]', '[sizeEnd]'],
			['居中', '[align=center]', '[alignEnd]']].forEach(function (p) {
			var b = el('button', '', tagbox);
			b.textContent = p[0];
			b.onclick = function () { insertTag(ta, p[1], p[2]); };
		});
		var ta = document.createElement('textarea');
		ta.className = 'textin';
		ta.value = n.text;
		ta.onchange = function () { pushHistory(); n.text = ta.value; refresh(); };
		tagwrap.appendChild(ta);
		propsEl.appendChild(mkCheck('原始标记(手动写[r][color]等)', n.raw, function (v) { n.raw = v; }));
		propsEl.appendChild(mkCheck('结束后清屏隐藏([hide][cm])', !n.chain, function (v) { n.chain = !v; }));
	}

	function insertTag(ta, open, close) {
		pushHistory();
		var s = ta.selectionStart;
		var e = ta.selectionEnd;
		var v = ta.value;
		if (s == e) {
			ta.value = v.substring(0, s) + open + close + v.substring(e);
			ta.selectionStart = ta.selectionEnd = s + open.length;
		} else {
			ta.value = v.substring(0, s) + open + v.substring(s, e) + close + v.substring(e);
			ta.selectionStart = s + open.length;
			ta.selectionEnd = e + open.length;
		}
		var n = curNode();
		if (n) n.text = ta.value;
		refresh();
	}

	function renderOptionProps(n) {
		n.options = n.options || [];
		var box = el('div', 'optlist', propsEl);
		function renderOpts() {
			box.innerHTML = '';
			n.options.forEach(function (o, i) {
				var row = el('div', 'optrow', box);
				var t = document.createElement('input');
				t.type = 'text';
				t.value = o.text;
				t.onchange = function () { pushHistory(); o.text = t.value; refresh(); };
				row.appendChild(t);
				var s = mkSelect(function (v) { o.target = parseInt(v); });
				var o0 = document.createElement('option');
				o0.value = '-1'; o0.textContent = '(选目标)';
				s.appendChild(o0);
				nodes.forEach(function (nd, idx) {
					if (nd === n) return;
					var op = document.createElement('option');
					op.value = nd.uid;
					op.textContent = '#' + (idx + 1) + ' ' + typeName(nd);
					s.appendChild(op);
				});
				s.value = o.target || -1;
				row.appendChild(s);
				var d = el('button', '', row);
				d.textContent = '×';
				d.onclick = function () { pushHistory(); n.options.splice(i, 1); renderOpts(); refresh(); };
			});
		}
		renderOpts();
		var add = el('button', '', propsEl);
		add.textContent = '+ 添加选项';
		add.onclick = function () {
			pushHistory();
			n.options.push({ text: '选项' + (n.options.length + 1), target: -1 });
			renderOpts();
		};
	}

	function renderJumpProps(n) {
		var s = mkSelect(function (v) { n.target = parseInt(v); });
		var o0 = document.createElement('option');
		o0.value = '-1'; o0.textContent = '(选目标)';
		s.appendChild(o0);
		nodes.forEach(function (nd, idx) {
			if (nd === curNode()) return;
			var op = document.createElement('option');
			op.value = nd.uid;
			op.textContent = '#' + (idx + 1) + ' ' + typeName(nd);
			s.appendChild(op);
		});
		s.value = n.target || -1;
		field('跳转到', s, propsEl);
	}

	function typeName(n) {
		switch (n.type) {
			case 'bg': return '背景';
			case 'chara': return '立绘';
			case 'text': return '对话';
			case 'sound': return '音乐';
			case 'stopSound': return '停音乐';
			case 'wait': return '等待';
			case 'shake': return '震动';
			case 'flash': return '闪光';
			case 'option': return '选项';
			case 'jump': return '跳转';
			case 'end': return '结束';
			default: return '其他';
		}
	}

	function nodeSummary(n) {
		switch (n.type) {
			case 'bg': return (n.hide ? '隐藏 ' : '') + (n.img || '');
			case 'chara': return '[' + (n.layer || '') + '] ' + (n.hide ? '隐藏 ' : '') + (n.img || '');
			case 'text': return (n.name || '') + ': ' + String(n.text || '').substring(0, 14);
			case 'sound': return n.snd || '';
			case 'stopSound': return n.channel || 'bgm';
			case 'wait': return (n.click ? '点击继续' : (n.time + 'ms'));
			case 'shake': return n.layer;
			case 'flash': return n.layer + ' ' + (n.time || 0) + 'ms';
			case 'option': return (n.options || []).map(function (o) { return o.text; }).join(' / ');
			case 'jump': return '→ #' + nodeIndexByUid(n.target);
			case 'end': return '';
			default: return '';
		}
	}

	function nodeIndexByUid(id) {
		for (var i = 0; i < nodes.length; i++) if (nodes[i].uid == id) return i + 1;
		return '?';
	}

	function renderList() {
		nodeListEl.innerHTML = '';
		nodes.forEach(function (n, i) {
			var item = el('div', 'nitem' + (i == sel ? ' sel' : ''), nodeListEl);
			var t = el('span', 'ntype t-' + n.type, item);
			t.textContent = typeName(n);
			var s = el('span', 'nsum', item);
			s.textContent = nodeSummary(n);
			item.onclick = function () {
				if (player.running) stopPlay();
				sel = i;
				renderAll();
			};
		});
		var cnt = el('div', 'ncount', nodeListEl);
		cnt.textContent = nodes.length ? ('共 ' + nodes.length + ' 个节点') : '(空剧情，点下方按钮添加)';
	}

	function refresh() {
		compile();
		player.env.vars = vars;
		player.env.resources = resources;
		updatePreview();
		renderList();
		syncPropXY();
	}

	function updatePreview() {
		if (player.running) return; // 播的时候别捣乱
		var n = curNode();
		clearHighlight();
		if (sel >= 0 && compiled && compiled.ranges[sel]) {
			player.preview(compiled.exps, compiled.ranges[sel][1]);
		} else if (compiled) {
			player.preview(compiled.exps, 0);
		}
		// 选中对话时把这句话摆上舞台
		if ($('pvDlg').checked && n && n.type == 'text') {
			player.dialogInstant(n.name, n.nameSide, n.text);
		}
		if (n && (n.type == 'bg' || n.type == 'chara')) highlight(n);
	}

	function syncPropXY() {
		var n = curNode();
		if (!n) return;
		var xi = $('propX');
		var yi = $('propY');
		if (xi) xi.value = Math.round(n.x);
		if (yi) yi.value = Math.round(n.y);
	}

	function highlight(n) {
		player.highlight = (n.type == 'bg') ? 'bg' : n.layer;
	}

	function clearHighlight() {
		player.highlight = null;
	}

	// 舞台拖拽(鼠标+触摸)
	function beginDrag(x, y) {
		if (player.running) return;
		var n = curNode();
		if (!n || (n.type != 'bg' && n.type != 'chara')) return;
		var pushed = false;
		var move = function (cx, cy) {
			if (!pushed) {
				pushHistory();
				pushed = true;
			}
			var r2 = player.root.getBoundingClientRect();
			var nx = (cx - r2.left) / stageScale;
			var ny = (cy - r2.top) / stageScale;
			var iw = n.type == 'bg' ? 1000 : 272;
			if (n.type == 'bg') {
				n.x = Math.round(nx - iw / 2);
				n.y = Math.round(ny - 300);
			} else {
				n.x = Math.round(nx - iw / 2);
				n.y = Math.round(ny - 240);
			}
			compile();
			player.preview(compiled.exps, compiled.ranges[sel][1]);
			highlight(n);
			syncPropXY();
		};
		var mm = function (ev) { move(ev.clientX, ev.clientY); };
		var tm = function (ev) {
			ev.preventDefault();
			move(ev.touches[0].clientX, ev.touches[0].clientY);
		};
		var up = function () {
			window.removeEventListener('mousemove', mm);
			window.removeEventListener('mouseup', up);
			window.removeEventListener('touchmove', tm);
			window.removeEventListener('touchend', up);
			refresh();
		};
		window.addEventListener('mousemove', mm);
		window.addEventListener('mouseup', up);
		window.addEventListener('touchmove', tm, { passive: false });
		window.addEventListener('touchend', up);
		move(x, y);
	}

	stageBox.addEventListener('mousedown', function (e) {
		beginDrag(e.clientX, e.clientY);
		e.preventDefault();
	});

	stageBox.addEventListener('touchstart', function (e) {
		beginDrag(e.touches[0].clientX, e.touches[0].clientY);
		e.preventDefault();
	}, { passive: false });

	var sndPreview = null;

	function stopSndPreview() {
		if (sndPreview) {
			sndPreview.pause();
			sndPreview = null;
		}
		var b = $('sndPvBtn');
		if (b) b.textContent = '试听';
	}

	function toggleSndPreview(name) {
		if (sndPreview) {
			stopSndPreview();
			return;
		}
		var src = GAoEngine.resolveSrc(name, 'snd', {
			assets: window.GAME_ASSETS || { snds: {} },
			resources: resources
		});
		if (!src) return;
		sndPreview = new Audio(src);
		sndPreview.loop = true;
		sndPreview.play();
		var b = $('sndPvBtn');
		if (b) b.textContent = '停止';
	}

	function stopPlay() {
		player.stop();
		stopSndPreview();
		$('btnPlayAll').disabled = false;
		$('btnPlayHere').disabled = false;
		$('btnStop').disabled = true;
		updatePreview();
	}

	function startPlay(fromSel) {
		if (!nodes.length) return;
		compile();
		var start = 0;
		if (fromSel && sel >= 0 && compiled.ranges[sel]) start = compiled.ranges[sel][0];
		$('btnPlayAll').disabled = true;
		$('btnPlayHere').disabled = true;
		$('btnStop').disabled = false;
		clearHighlight();
		player.play(compiled.exps, start, function () {
			$('btnPlayAll').disabled = false;
			$('btnPlayHere').disabled = false;
			$('btnStop').disabled = true;
			updatePreview();
		});
	}

	function exportJSON() {
		if (player.running) stopPlay();
		compile();
		var data = { des: story.des, script: story.script, exps: compiled.exps };
		var resKeys = Object.keys(resources);
		if (resKeys.length) data.resources = resources;
		var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
		var a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = (story.script || 'story') + '.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function importJSONData(data) {
		if (player.running) stopPlay();
		pushHistory();
		if (!data || !data.exps) {
			alert('不是有效的剧情 JSON');
			return;
		}
		story.des = data.des || '';
		story.script = data.script || '';
		$('metaDes').value = story.des;
		$('metaScript').value = story.script;
		if (data.resources) {
			for (var k in data.resources) resources[k] = data.resources[k];
			renderResList();
		}
		nodes = decompile(data.exps);
		sel = nodes.length ? 0 : -1;
		renderAll();
	}

	function importFile(file) {
		var r = new FileReader();
		r.onload = function () {
			try {
				importJSONData(JSON.parse(r.result));
			} catch (e) {
				alert('JSON 解析失败: ' + e.message);
			}
		};
		r.readAsText(file, 'utf-8');
	}

	function importRes(kind) {
		var inp = document.createElement('input');
		inp.type = 'file';
		inp.multiple = true;
		inp.accept = kind == 'img' ? 'image/*' : 'audio/*';
		inp.onchange = function () {
			var files = inp.files;
			if (!files.length) return;
			var done = 0;
			for (var i = 0; i < files.length; i++) {
				(function (f) {
					var r = new FileReader();
					r.onload = function () {
						var name = f.name.replace(/\.[^.]+$/, '');
						if (window.GAME_ASSETS && ((kind == 'img' && GAME_ASSETS.imgs[name]) || (kind == 'snd' && GAME_ASSETS.snds[name]))) {
							name = 'c_' + name;
							var dup = 2;
							while (resources[name]) {
								name = 'c_' + f.name.replace(/\.[^.]+$/, '') + '_' + dup;
								dup++;
							}
						} else {
							var dup2 = 2;
							while (resources[name]) {
								name = f.name.replace(/\.[^.]+$/, '') + '_' + dup2;
								dup2++;
							}
						}
						resources[name] = { type: kind, data: r.result };
						done++;
						if (done == files.length) {
							renderResList();
							refresh();
						}
					};
					r.readAsDataURL(f);
				})(files[i]);
			}
		};
		inp.click();
	}

	function renderResList() {
		var box = $('resList');
		box.innerHTML = '';
		var keys = Object.keys(resources);
		$('resCount').textContent = keys.length ? ('自定义资源 ' + keys.length + ' 个') : '';
		keys.forEach(function (k) {
			var row = el('div', 'resitem', box);
			var icon = el('span', '', row);
			icon.textContent = resources[k].type == 'img' ? '[图]' : '[音]';
			var nm = el('span', '', row);
			nm.textContent = k;
			var del = el('button', '', row);
			del.textContent = '×';
			del.onclick = function () {
				delete resources[k];
				renderResList();
				refresh();
			};
		});
	}

	function firstImgOf(catPrefix) {
		var A = window.GAME_ASSETS || { imgs: {} };
		var names = Object.keys(A.imgs).filter(function (k) {
			return A.imgs[k].cat.indexOf(catPrefix) == 0;
		});
		names.sort();
		return names[0] || '';
	}

	function addNode(type) {
		var n = null;
		switch (type) {
			case 'bg':
				n = { type: 'bg', layer: 'bg', img: firstImgOf('bg'), x: -200, y: 0, scaleX: 1, scaleY: 1, mirror: false, bright: 1, transTime: 300, alpha: 1, hide: false };
				break;
			case 'chara':
				n = { type: 'chara', layer: 'chara1', img: firstImgOf('chara/nvzhu') || firstImgOf('chara'), x: 64, y: 114, scaleX: 1, scaleY: 1, mirror: false, bright: 1, transTime: 300, alpha: 1, hide: false, bringFront: true };
				break;
			case 'text':
				n = { type: 'text', name: '{nvzhuName}', nameSide: 'left', text: '', raw: false };
				break;
			case 'sound':
				var A = window.GAME_ASSETS || { snds: {} };
				n = { type: 'sound', snd: Object.keys(A.snds).sort()[0] || '', volume: 1, loop: true, channel: 'bgm' };
				break;
			case 'wait':
				n = { type: 'wait', time: 500 };
				break;
			case 'option':
				n = { type: 'option', options: [{ text: '选项1', target: -1 }, { text: '选项2', target: -1 }] };
				break;
			case 'jump':
				n = { type: 'jump', target: -1 };
				break;
			case 'end':
				n = { type: 'end' };
				break;
		}
			n.uid = uid++;
			pushHistory();
			if (sel >= 0 && sel < nodes.length - 1) nodes.splice(sel + 1, 0, n);
			else nodes.push(n);
		sel = nodes.indexOf(n);
		renderAll();
	}

	function renderAll() {
		renderList();
		renderProps();
		refresh();
	}

	$('btnNew').onclick = function () {
		if (player.running) stopPlay();
		if (nodes.length && !confirm('新建会清空当前剧情，确定？')) return;
		pushHistory();
		nodes = [];
		story = { des: '新剧情', script: 'new001' };
		$('metaDes').value = story.des;
		$('metaScript').value = story.script;
		sel = -1;
		renderAll();
	};

	$('btnImport').onclick = function () {
		var inp = document.createElement('input');
		inp.type = 'file';
		inp.accept = '.json';
		inp.onchange = function () {
			if (inp.files[0]) importFile(inp.files[0]);
		};
		inp.click();
	};

	$('btnExport').onclick = exportJSON;
	$('btnImgRes').onclick = function () { importRes('img'); };
	$('btnSndRes').onclick = function () { importRes('snd'); };

	$('btnPlayAll').onclick = function () { startPlay(false); };
	$('btnPlayHere').onclick = function () { startPlay(true); };
	$('btnStop').onclick = stopPlay;

	$('btnFull').onclick = function () {
		if (document.fullscreenElement) {
			document.exitFullscreen();
			return;
		}
		var fn = stageWrap.requestFullscreen || stageWrap.webkitRequestFullscreen;
		if (!fn) {
			alert('浏览器不支持全屏');
			return;
		}
		var p = fn.call(stageWrap);
		if (p && p.then) {
			p.then(function () {
				// 手机上全屏锁横屏
				if (screen.orientation && screen.orientation.lock) {
					screen.orientation.lock('landscape').catch(function () {});
				}
			}).catch(function () {});
		}
	};

	$('fsExit').onclick = function () {
		if (document.fullscreenElement) document.exitFullscreen();
	};

	document.addEventListener('fullscreenchange', fitStage);
	document.addEventListener('webkitfullscreenchange', fitStage);

	$('metaDes').onchange = function () { pushHistory(); story.des = $('metaDes').value; };
	$('metaScript').onchange = function () { pushHistory(); story.script = $('metaScript').value; };

	$('pvDlg').onchange = function () { updatePreview(); };

	['nvzhuName', 'jinglingName', 'nanzhuName'].forEach(function (k) {
		$('var_' + k).value = vars[k];
		$('var_' + k).onchange = function () {
			vars[k] = $('var_' + k).value;
			refresh();
		};
	});

	// 关于
	$('btnAbout').onclick = function () { $('aboutBox').style.display = 'block'; };
	$('aboutClose').onclick = function () { $('aboutBox').style.display = 'none'; };
	$('aboutMask').onclick = function () { $('aboutBox').style.display = 'none'; };

	// 添加节点按钮
	var addMap = [['btnAddBg', 'bg'], ['btnAddChara', 'chara'], ['btnAddText', 'text'],
		['btnAddSnd', 'sound'], ['btnAddWait', 'wait'], ['btnAddOpt', 'option'],
		['btnAddEnd', 'end']];
	addMap.forEach(function (p) {
		$(p[0]).onclick = function () { addNode(p[1]); };
	});

	fitStage();
	renderAll();

	// 折叠栏, 手机端默认收起
	var folds = document.querySelectorAll('.fold');
	for (var fi = 0; fi < folds.length; fi++) {
		(function (b) {
			var t = $(b.dataset.target);
			b.onclick = function () {
				t.classList.toggle('folded');
				b.classList.toggle('closed');
			};
			if (window.innerWidth <= 900) {
				t.classList.add('folded');
				b.classList.add('closed');
			}
		})(folds[fi]);
	}

	// 控制台调试用
	window.GAO = {
		player: player,
		importJSONData: importJSONData,
		compile: function () { return compile(); },
		get story() { return story; },
		get nodes() { return nodes; },
		get resources() { return resources; },
		get vars() { return vars; }
	};
})();

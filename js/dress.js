(function () {
	'use strict';

	document.addEventListener('contextmenu', function (e) {
		e.preventDefault();
	});

	var D = window.DRESS_DATA;
	var STAGE_W = 1000, STAGE_H = 600;
	// 原版 DressPanel showMode 下 mc_chara.x=154, mannequin 原点 y=0
	var MAN_X = 154, MAN_Y = 0;

	var clothes = D.clothes.clothes;
	var layersDef = {};
	D.setting.part.forEach(function (o) { layersDef[o.layer] = o; });
	var IMG_FOLDERS = D.imglist;

	// 官方服装id集合, 导出时官方只引用id, 自定义的才内嵌
	var OFFICIAL = {};
	D.clothes.clothes.forEach(function (c) { OFFICIAL[c.id] = true; });

	var resources = {}; // 自定义图片 name -> {type:'img', data:dataURL}
	var outfit = D.setting2.default_dress.map(Number); // 当前穿搭(不含底层)
	var baseIds = D.setting2.empty_dress.map(Number);
	var selId = null;   // 选中的服装id
	var selPart = -1;   // 选中的部件下标
	var filter = '';
	var recolor = null; // 改色预览状态 {id, hue, sat, bri}

	// ---------------- 基础工具 ----------------

	function $(id) { return document.getElementById(id); }
	var stageBox = $('stageBox');
	var clothListEl = $('clothList');
	var wearListEl = $('wearList');
	var propsEl = $('props');

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

	function mkSelect(onch) {
		var s = document.createElement('select');
		s.onchange = function () { pushHistory(); onch(s.value); refresh(); };
		return s;
	}

	function mkRange(min, max, step, value, onch) {
		var box = document.createElement('span');
		box.className = 'rangebox';
		var i = document.createElement('input');
		i.type = 'range';
		i.min = min; i.max = max; i.step = step;
		i.value = value;
		var v = document.createElement('span');
		v.className = 'rangeval';
		v.textContent = value;
		i.oninput = function () {
			v.textContent = i.value;
			onch(parseFloat(i.value));
			renderPose();
		};
		box.appendChild(i);
		box.appendChild(v);
		return box;
	}

	function byId(id) {
		for (var i = 0; i < clothes.length; i++) if (clothes[i].id == id) return clothes[i];
		return null;
	}

	function layerName(l) {
		var d = layersDef[l];
		return d ? d.name : ('层' + l);
	}

	// data/img/xxx -> assets/dress/img/xxx, res:name -> 自定义资源
	function resolveSrc(img) {
		if (!img) return '';
		if (img.indexOf('res:') == 0) {
			var r = resources[img.slice(4)];
			return r ? r.data : '';
		}
		if (img.indexOf('data/') == 0) return 'assets/dress/' + img.slice(5);
		return img;
	}

	// ---------------- 撤销/恢复 ----------------

	var undoStack = [];
	var redoStack = [];
	var lastPush = 0;

	function snapshot() { return JSON.stringify(clothes); }

	function pushHistory() {
		var now = Date.now();
		if (now - lastPush < 400 && undoStack.length) { lastPush = now; return; }
		undoStack.push(snapshot());
		if (undoStack.length > 50) undoStack.shift();
		redoStack = [];
		lastPush = now;
		updateUndoBtns();
	}

	function restore(snap) {
		clothes = JSON.parse(snap);
		if (selId != null && !byId(selId)) selId = null;
		lastPush = 0;
		refresh();
	}

	function doUndo() {
		if (!undoStack.length) return;
		redoStack.push(snapshot());
		restore(undoStack.pop());
		updateUndoBtns();
	}

	function doRedo() {
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

	// ---------------- 穿搭逻辑 (还原 PoseMan) ----------------

	// 底层(内衣/身体)是否被某层列表盖住, 同 checkBaseShow
	function baseHidden(vo) {
		var info = layersDef[vo.parts[0].layer];
		var ct = info && info.ct;
		if (ct) {
			var arr = ct.split(',');
			for (var i = 0; i < arr.length; i++) {
				if (hasWornLayer(arr[i])) return true;
			}
			return false;
		}
		return hasWornLayer(vo.parts[0].layer);
	}

	function hasWornLayer(l) {
		for (var i = 0; i < outfit.length; i++) {
			var c = byId(outfit[i]);
			if (!c) continue;
			for (var j = 0; j < c.parts.length; j++) {
				if (c.parts[j].layer == l) return true;
			}
		}
		return false;
	}

	function wornLayersOf(id) {
		var c = byId(id);
		var set = {};
		if (c) c.parts.forEach(function (p) {
			if (p.img) set[p.layer] = true; // 原版DataCenter会剔除img为空的占位部件, 冲突判定同样忽略
		});
		return set;
	}

	// 穿上, 冲突机制还原原版 dressOnPrepareComplete:
	// 1) 同层逐出: 新部件占用的层, 原占用者整件脱掉
	// 2) ct逐出: 首层定义的ct列表(如连衣装14 -> 9,9.5,15,13,18,18.5,8.9,14.5), 这些层的占用者整件脱掉
	//    例外: 自己就是该层的底层衣物时不触发ct逐出
	function dressOn(id) {
		id = Number(id);
		var c = byId(id);
		if (!c) return;
		var occupied = {};
		c.parts.forEach(function (p) {
			if (p.img) occupied[p.layer] = true; // 空占位部件不参与冲突
		});
		outfit = outfit.filter(function (wid) {
			var ls = wornLayersOf(wid);
			for (var k in ls) if (occupied[k]) return false;
			return true;
		});
		// ct取第一个有图的部件, 空占位不算
		var firstReal = null;
		c.parts.forEach(function (p) { if (!firstReal && p.img) firstReal = p; });
		var info = firstReal ? layersDef[firstReal.layer] : null;
		var ct = info && info.ct;
		if (ct && baseIds.indexOf(id) < 0) {
			ct.split(',').forEach(function (l) {
				l = l.trim();
				outfit = outfit.filter(function (wid) {
					return wornLayersOf(wid)[l] == null;
				});
			});
		}
		if (outfit.indexOf(id) < 0) outfit.push(id);
	}

	function dressOff(id) {
		outfit = outfit.filter(function (w) { return w != id; });
	}

	// 收集可见部件, 按层排序
	function collectParts() {
		var list = [];
		baseIds.forEach(function (id) {
			var c = byId(id);
			if (c && !baseHidden(c)) {
				c.parts.forEach(function (p, pi) {
					if (p.img) list.push({ cloth: c, part: p, pi: pi, base: true });
				});
			}
		});
		outfit.forEach(function (id) {
			var c = byId(id);
			if (c) {
				c.parts.forEach(function (p, pi) {
					if (p.img) list.push({ cloth: c, part: p, pi: pi, base: false });
				});
			}
		});
		list.sort(function (a, b) { return parseFloat(a.part.layer) - parseFloat(b.part.layer); });
		return list;
	}

	// ---------------- 舞台 (真canvas, 和剧情编辑器一致; 点击按像素alpha命中) ----------------

	var stageEl = document.createElement('canvas');
	stageEl.id = 'dressCanvas';
	stageEl.width = STAGE_W;
	stageEl.height = STAGE_H;
	stageBox.appendChild(stageEl);
	var ctx = stageEl.getContext('2d');
	var ROOM_SRC = 'assets/dress/room.jpg';
	var SHADOW_SRC = 'assets/dress/shadow.svg'; // 原版脚下阴影, 模型坐标系(114.5,526.9)
	var SHADOW_X = 114.5, SHADOW_Y = 526.9;

	var imgCache = {};
	function cacheImg(src) {
		if (!src) return null;
		var im = imgCache[src];
		if (!im) {
			im = new Image();
			im.onload = function () { renderPose(); };
			im.src = src;
			imgCache[src] = im;
		}
		return im;
	}

	// alpha采样用离屏画布, 每张图缓存一份
	var alphaCache = {};
	var alphaOk = true; // file://下canvas被污染getImageData会抛异常, 退化为矩形命中
	function alphaAt(src, x, y) {
		var im = cacheImg(src);
		if (!im || !im.complete || !im.naturalWidth) return 0;
		if (x < 0 || y < 0 || x >= im.naturalWidth || y >= im.naturalHeight) return 0;
		if (!alphaOk) return 255; // 污染模式: 图片矩形内都算命中
		var cv = alphaCache[src];
		if (!cv) {
			cv = document.createElement('canvas');
			cv.width = im.naturalWidth;
			cv.height = im.naturalHeight;
			cv.getContext('2d').drawImage(im, 0, 0);
			alphaCache[src] = cv;
		}
		try {
			return cv.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3];
		} catch (e) {
			alphaOk = false; // 跨域污染(file://直接打开), 之后走矩形命中
			return 255;
		}
	}

	var stageScale = 1;
	function fitStage() {
		var wrap = $('stageWrap');
		var mobile = window.innerWidth <= 900;
		var s;
		if (mobile) {
			// 手机端: 画布贴满首屏, 容器高度跟着画布走, 不留黑边
			var th = $('topbar').offsetHeight || 40;
			var w = wrap.clientWidth || window.innerWidth;
			var h = window.innerHeight - th;
			s = Math.min(w / STAGE_W, h / STAGE_H);
			wrap.style.height = (STAGE_H * s) + 'px';
			wrap.style.maxHeight = 'none';
			wrap.style.flex = 'none';
		} else {
			wrap.style.height = '';
			wrap.style.maxHeight = '';
			var pad = 20;
			var w2 = wrap.clientWidth - pad, h2 = wrap.clientHeight - pad;
			if (w2 <= 0 || h2 <= 0) return;
			s = Math.min(1, w2 / STAGE_W, h2 / STAGE_H);
		}
		stageScale = s;
		stageEl.style.width = (STAGE_W * s) + 'px';
		stageEl.style.height = (STAGE_H * s) + 'px';
		stageBox.style.width = (STAGE_W * s) + 'px';
		stageBox.style.height = (STAGE_H * s) + 'px';
	}
	window.addEventListener('resize', fitStage);

	function renderPose() {
		ctx.clearRect(0, 0, STAGE_W, STAGE_H);
		var roomIm = cacheImg(ROOM_SRC);
		if (roomIm && roomIm.complete && roomIm.naturalWidth) {
			ctx.drawImage(roomIm, 0, 0, STAGE_W, STAGE_H);
		}
		var shIm = cacheImg(SHADOW_SRC);
		if (shIm && shIm.complete && shIm.naturalWidth) {
			ctx.drawImage(shIm, MAN_X + SHADOW_X, MAN_Y + SHADOW_Y);
		}
		var selIt = null;
		collectParts().forEach(function (it) {
			var im = cacheImg(resolveSrc(it.part.img));
			if (im && im.complete && im.naturalWidth) {
				// 改色预览: 选中服装的部件套canvas滤镜
				if (recolor && recolor.id == it.cloth.id) {
					ctx.filter = 'hue-rotate(' + recolor.hue + 'deg) saturate(' + recolor.sat + '%) brightness(' + recolor.bri + '%)';
					ctx.drawImage(im, MAN_X + it.part.fix.x, MAN_Y + it.part.fix.y);
					ctx.filter = 'none';
				} else {
					ctx.drawImage(im, MAN_X + it.part.fix.x, MAN_Y + it.part.fix.y);
				}
				if (it.cloth.id == selId && it.pi == selPart) selIt = { it: it, im: im };
			}
		});
		if (selIt) drawSelMark(selIt.it, selIt.im);
	}

	// 选中框 + 名称标签
	function drawSelMark(it, im) {
		var x = MAN_X + it.part.fix.x;
		var y = MAN_Y + it.part.fix.y;
		var w = im.naturalWidth, h = im.naturalHeight;
		ctx.save();
		ctx.strokeStyle = '#dd8844';
		ctx.lineWidth = 2;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
		ctx.setLineDash([]);
		var label = it.cloth.name + ' · ' + layerName(it.part.layer);
		ctx.font = '12px "Microsoft YaHei", sans-serif';
		var tw = ctx.measureText(label).width;
		var ly = y < 20 ? y + h + 4 : y - 18;
		ctx.fillStyle = 'rgba(0,0,0,0.55)';
		ctx.fillRect(x, ly, tw + 10, 16);
		ctx.fillStyle = '#fff';
		ctx.fillText(label, x + 5, ly + 12);
		ctx.restore();
	}

	// 点击命中: 从最上层往下, 逐层采样透明度, 透明区域不算
	function hitTest(x, y) {
		var list = collectParts();
		for (var i = list.length - 1; i >= 0; i--) {
			var it = list[i];
			var px = x - (MAN_X + it.part.fix.x);
			var py = y - (MAN_Y + it.part.fix.y);
			if (alphaAt(resolveSrc(it.part.img), px, py) > 8) return it;
		}
		return null;
	}

	function beginDrag(it, x, y) {
		var p = it.part;
		var pushed = false;
		var move = function (cx, cy) {
			if (!pushed) { pushHistory(); pushed = true; }
			var r = stageEl.getBoundingClientRect();
			p.fix.x = Math.round((cx - r.left) / stageScale) - MAN_X;
			p.fix.y = Math.round((cy - r.top) / stageScale) - MAN_Y;
			renderPose();
			syncPropXY();
		};
		var mm = function (ev) { move(ev.clientX, ev.clientY); };
		var up = function () {
			window.removeEventListener('pointermove', mm);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			refresh();
		};
		window.addEventListener('pointermove', mm);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		move(x, y);
	}

	// 统一指针事件 (鼠标+触摸), 事件绑在canvas上, 不存在DOM重建断流问题
	stageEl.addEventListener('pointerdown', function (e) {
		e.preventDefault();
		var r = stageEl.getBoundingClientRect();
		var x = (e.clientX - r.left) / stageScale;
		var y = (e.clientY - r.top) / stageScale;
		var hit = hitTest(x, y);
		if (hit) {
			select(hit.cloth.id, hit.pi);
			beginDrag(hit, e.clientX, e.clientY);
		} else {
			select(null, -1); // 点空白取消选中
		}
	});

	// 键盘方向键微调选中部件 (Shift=10px)
	document.addEventListener('keydown', function (e) {
		if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
		if (selId == null || selPart < 0) return;
		var c = byId(selId);
		if (!c || !c.parts[selPart]) return;
		var d = e.shiftKey ? 10 : 1;
		var dx = 0, dy = 0;
		switch (e.key) {
			case 'ArrowLeft': dx = -d; break;
			case 'ArrowRight': dx = d; break;
			case 'ArrowUp': dy = -d; break;
			case 'ArrowDown': dy = d; break;
			default: return;
		}
		e.preventDefault();
		pushHistory();
		c.parts[selPart].fix.x += dx;
		c.parts[selPart].fix.y += dy;
		renderPose();
		syncPropXY();
	});

	function select(id, pi) {
		selId = id;
		selPart = pi;
		renderPose();
		renderWearList();
		renderProps();
	}

	function syncPropXY() {
		var c = selId != null ? byId(selId) : null;
		if (!c || selPart < 0) return;
		var p = c.parts[selPart];
		var xi = $('propX'), yi = $('propY');
		if (xi) xi.value = p.fix.x;
		if (yi) yi.value = p.fix.y;
	}

	// ---------------- 左侧列表 ----------------

	function renderWearList() {
		wearListEl.innerHTML = '';
		baseIds.forEach(function (id) {
			var c = byId(id);
			if (!c) return;
			var row = el('div', 'wearitem', wearListEl);
			var nm = el('span', 'wname', row);
			nm.textContent = '[底层] ' + c.name;
			row.onclick = function () { select(id, -1); };
		});
		outfit.forEach(function (id) {
			var c = byId(id);
			if (!c) return;
			var row = el('div', 'wearitem' + (id == selId ? ' sel' : ''), wearListEl);
			var nm = el('span', 'wname', row);
			nm.textContent = c.name + ' (' + layerName(c.parts[0].layer) + ')';
			var off = el('button', '', row);
			off.textContent = '脱下';
			off.onclick = function (e) {
				e.stopPropagation();
				dressOff(id);
				renderWearList();
				renderPose();
				renderLib();
			};
			row.onclick = function () { select(id, -1); };
		});
	}

	function libGroups() {
		var groups = {}; // layer -> [cloth]
		clothes.forEach(function (c) {
			var l = c.parts[0].layer;
			if (!groups[l]) groups[l] = [];
			groups[l].push(c);
		});
		return Object.keys(groups).sort(function (a, b) {
			return parseFloat(a) - parseFloat(b);
		}).map(function (l) {
			return { layer: l, items: groups[l] };
		});
	}

	function matchFilter(c) {
		if (!filter) return true;
		return (c.name || '').indexOf(filter) >= 0 || String(c.id).indexOf(filter) >= 0;
	}

	function renderLib() {
		clothListEl.innerHTML = '';
		libGroups().forEach(function (g) {
			var items = g.items.filter(matchFilter);
			if (!items.length) return;
			var head = el('div', 'cgroup', clothListEl);
			head.textContent = layerName(g.layer) + ' (' + items.length + ')';
			items.forEach(function (c) {
				var row = el('div', 'citem' + (outfit.indexOf(c.id) >= 0 ? ' worn' : ''), clothListEl);
				var idl = el('span', 'cid', row);
				idl.textContent = c.id;
				var nm = el('span', 'cname', row);
				nm.textContent = c.name || '(未命名)';
				row.title = c.name + ' 人气' + c.rq + ' ¥' + c.money;
				row.onclick = function () {
					if (outfit.indexOf(c.id) >= 0) {
						dressOff(c.id);
					} else {
						dressOn(c.id);
					}
					select(c.id, -1);
					renderWearList();
					renderPose();
					renderLib();
				};
			});
		});
		$('clothCount').textContent = '共 ' + clothes.length + ' 件';
	}

	$('filterIn').oninput = function () {
		filter = $('filterIn').value.trim();
		renderLib();
	};

	// ---------------- 属性面板 ----------------

	var VALUE_KEYS = D.setting.value;
	var STYLE_KEYS = D.setting.style;
	var COLOR_KEYS = D.setting.color;
	var TYPE_KEYS = D.setting.type;

	var ELEMENT_KEYS = [], WORK_KEYS = [];
	(function () {
		var es = {}, ws = {};
		clothes.forEach(function (c) {
			(c.type_element || []).forEach(function (t) { es[t] = true; });
			(c.type_work || []).forEach(function (t) { ws[t] = true; });
		});
		ELEMENT_KEYS = Object.keys(es).sort();
		WORK_KEYS = Object.keys(ws).sort();
	})();

	function renderProps() {
		propsEl.innerHTML = '';
		var c = selId != null ? byId(selId) : null;
		if (!c) {
			propsEl.innerHTML = '<div class="tip">在左侧点击服装穿上，点舞台上的部件进行编辑</div>';
			return;
		}
		var head = el('div', 'phead', propsEl);
		head.textContent = '服装 #' + c.id + ' ' + (c.name || '');

		// ---- 部件 ----
		var ph = el('div', 'phead', propsEl);
		ph.textContent = '部件';
		c.parts.forEach(function (p, pi) {
			var row = el('div', 'optrow', propsEl);
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '4px';
			if (pi == selPart) row.style.background = '#e3d3bd';
			var ls = mkSelect(function (v) { p.layer = v; renderPose(); });
			ls.onclick = function (e) { e.stopPropagation(); };
			Object.keys(layersDef).forEach(function (l) {
				var o = document.createElement('option');
				o.value = l;
				o.textContent = l + ' ' + layersDef[l].name;
				ls.appendChild(o);
			});
			ls.value = p.layer;
			row.appendChild(ls);
			var del = el('button', '', row);
			del.textContent = '×';
			del.onclick = function (e) {
				e.stopPropagation();
				pushHistory();
				c.parts.splice(pi, 1);
				if (selPart >= c.parts.length) selPart = c.parts.length - 1;
				refresh();
			};
			row.appendChild(del);
			row.onclick = function () { select(c.id, pi); };
		});
		var addP = el('button', '', propsEl);
		addP.textContent = '+ 添加部件';
		addP.onclick = function () {
			pushHistory();
			c.parts.push({ img: '', layer: '15', fix: { x: 0, y: 0 } });
			select(c.id, c.parts.length - 1);
		};

		// ---- 选中部件编辑 ----
		if (selPart >= 0 && c.parts[selPart]) {
			var p = c.parts[selPart];
			var ph2 = el('div', 'phead', propsEl);
			ph2.textContent = '部件属性 · ' + layerName(p.layer);

			var isel = mkSelect(function (v) { p.img = v; renderPose(); });
			fillImgSelect(isel, p.img);
			field('图片', isel, propsEl);

			var xy = el('div', 'xyrow', propsEl);
			var xl = el('label', '', xy); xl.textContent = 'X';
			var xi = mkInput('number', p.fix.x, function (i) { p.fix.x = parseInt(i.value) || 0; });
			xi.className = 'xyin'; xi.id = 'propX';
			xy.appendChild(xi);
			var yl = el('label', '', xy); yl.textContent = 'Y';
			var yi = mkInput('number', p.fix.y, function (i) { p.fix.y = parseInt(i.value) || 0; });
			yi.className = 'xyin'; yi.id = 'propY';
			xy.appendChild(yi);
			var hint = el('span', 'xyhint', xy);
			hint.textContent = '可拖拽/方向键微调';
			propsEl.appendChild(xy);
		}

		// ---- 服装属性 ----
		var ph3 = el('div', 'phead', propsEl);
		ph3.textContent = '服装属性';

		field('名称', mkInput('text', c.name, function (i) { c.name = i.value; }), propsEl);
		field('编号', mkInput('number', c.id, function (i) { c.id = parseInt(i.value) || c.id; }), propsEl);

		var ts = mkSelect(function (v) { c.type = v; });
		TYPE_KEYS.forEach(function (t) {
			var o = document.createElement('option');
			o.value = t; o.textContent = t;
			ts.appendChild(o);
		});
		ts.value = c.type || TYPE_KEYS[0];
		field('类型', ts, propsEl);

		field('人气', mkInput('number', c.rq, function (i) { c.rq = parseInt(i.value) || 0; }), propsEl);
		field('售价', mkInput('number', c.money, function (i) { c.money = parseInt(i.value) || 0; }), propsEl);

		renderTagBox('风格', 'type_style', STYLE_KEYS);
		renderTagBox('颜色', 'type_color', COLOR_KEYS);
		renderTagBox('元素', 'type_element', ELEMENT_KEYS);
		renderTagBox('工艺', 'type_work', WORK_KEYS);

		var vh = el('div', 'phead', propsEl);
		vh.textContent = '属性值';
		VALUE_KEYS.forEach(function (k) {
			var cur = c.type_value && c.type_value[k] ? parseInt(c.type_value[k].value) : 5;
			var row = el('div', 'vrow', propsEl);
			var lb = el('label', '', row);
			lb.textContent = k;
			row.appendChild(mkRange(1, 9, 1, cur, function (v) {
				c.type_value = c.type_value || {};
				c.type_value[k] = { value: v, name: k };
			}));
		});

		// ---- 改色 (色调/饱和度/亮度, 应用后存为新服装) ----
		var ch = el('div', 'phead', propsEl);
		ch.textContent = '改色';
		var hasImg = c.parts.some(function (p) { return p.img; });
		if (!hasImg) {
			el('div', 'tip', propsEl).textContent = '这件服装没有图片, 无法改色';
		} else {
			if (!recolor || recolor.id != c.id) {
				recolor = { id: c.id, hue: 0, sat: 100, bri: 100 };
			}
			var mkRSRange = function (min, max, step, label, key, unit) {
				var row = el('div', 'vrow', propsEl);
				var lb = el('label', '', row);
				lb.textContent = label;
				var box = el('span', 'rangebox', row);
				var i = document.createElement('input');
				i.type = 'range';
				i.min = min; i.max = max; i.step = step;
				i.value = recolor[key];
				var v = document.createElement('span');
				v.className = 'rangeval';
				v.textContent = recolor[key] + unit;
				i.oninput = function () {
					recolor[key] = parseFloat(i.value);
					v.textContent = i.value + unit;
					renderPose();
				};
				box.appendChild(i);
				box.appendChild(v);
				return box;
			};
			mkRSRange(-180, 180, 1, '色调', 'hue', '°');
			mkRSRange(0, 200, 5, '饱和度', 'sat', '%');
			mkRSRange(0, 200, 5, '亮度', 'bri', '%');
			var rsOps = el('div', 'pops', propsEl);
			var bApply = el('button', '', rsOps);
			bApply.textContent = '应用为新服装';
			bApply.onclick = applyRecolor;
			var bReset = el('button', '', rsOps);
			bReset.textContent = '重置';
			bReset.onclick = function () {
				recolor = { id: c.id, hue: 0, sat: 100, bri: 100 };
				renderPose();
				renderProps();
			};
			var tip = el('div', 'tip', propsEl);
			tip.textContent = '改色会另存为一件新服装, 不影响原服装';
		}

		var delC = el('button', '', propsEl);
		delC.textContent = '删除这件服装';
		delC.onclick = function () {
			if (!confirm('确定删除 #' + c.id + ' ' + c.name + ' ？')) return;
			pushHistory();
			dressOff(c.id);
			clothes = clothes.filter(function (x) { return x != c; });
			selId = null; selPart = -1;
			refresh();
		};
		delC.style.marginTop = '8px';
	}

	function renderTagBox(label, key, keys) {
		var c = byId(selId);
		if (!c) return;
		var wrap = el('div', 'tagwrap', propsEl);
		var lb = el('label', 'flabel', wrap);
		lb.textContent = label;
		var box = el('div', 'tagbox', wrap);
		var cur = c[key] || [];
		keys.forEach(function (k) {
			var b = el('button', '', box);
			b.textContent = k;
			if (cur.indexOf(k) >= 0) b.style.background = '#d9c8b2';
			b.onclick = function () {
				pushHistory();
				var i = cur.indexOf(k);
				if (i >= 0) cur.splice(i, 1);
				else cur.push(k);
				c[key] = cur;
				refresh();
			};
		});
		var inp = document.createElement('input');
		inp.type = 'text';
		inp.style.width = '70px';
		inp.placeholder = '自定义';
		inp.onchange = function () {
			var v = inp.value.trim();
			if (!v) return;
			pushHistory();
			if (cur.indexOf(v) < 0) cur.push(v);
			c[key] = cur;
			refresh();
		};
		box.appendChild(inp);
	}

	function fillImgSelect(selEl, cur) {
		selEl.innerHTML = '';
		var og0 = document.createElement('optgroup');
		og0.label = '(无)';
		var o0 = document.createElement('option');
		o0.value = ''; o0.textContent = '(无图片)';
		og0.appendChild(o0);
		selEl.appendChild(og0);
		Object.keys(IMG_FOLDERS).forEach(function (folder) {
			var og = document.createElement('optgroup');
			og.label = folder;
			IMG_FOLDERS[folder].forEach(function (f) {
				var name = 'data/img/' + folder + '/' + f;
				var o = document.createElement('option');
				o.value = name;
				o.textContent = f.replace(/\.png$/, '');
				og.appendChild(o);
			});
			selEl.appendChild(og);
		});
		var custom = Object.keys(resources);
		if (custom.length) {
			var og2 = document.createElement('optgroup');
			og2.label = '自定义';
			custom.forEach(function (name) {
				var o = document.createElement('option');
				o.value = 'res:' + name;
				o.textContent = name;
				og2.appendChild(o);
			});
			selEl.appendChild(og2);
		}
		if (cur && !selEl.querySelector('option[value="' + cur.replace(/"/g, '\\"') + '"]')) {
			var o3 = document.createElement('option');
			o3.value = cur;
			o3.textContent = cur + ' (缺失)';
			selEl.appendChild(o3);
		}
		selEl.value = cur || '';
	}

	// ---------------- 自定义资源 ----------------

	// 裁掉四周多余透明区域, 只留非透明内容的最小矩形
	function trimImage(dataUrl, cb) {
		var im = new Image();
		im.onload = function () {
			var cv = document.createElement('canvas');
			cv.width = im.naturalWidth;
			cv.height = im.naturalHeight;
			var ctx = cv.getContext('2d');
			ctx.drawImage(im, 0, 0);
			var d;
			try { d = ctx.getImageData(0, 0, cv.width, cv.height); }
			catch (e) { cb(dataUrl); return; }
			var minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
			for (var y = 0; y < cv.height; y++) {
				for (var x = 0; x < cv.width; x++) {
					if (d.data[(y * cv.width + x) * 4 + 3] > 8) {
						if (x < minX) minX = x;
						if (x > maxX) maxX = x;
						if (y < minY) minY = y;
						if (y > maxY) maxY = y;
					}
				}
			}
			if (maxX < 0) { cb(dataUrl); return; } // 全透明, 不动
			var w = maxX - minX + 1, h = maxY - minY + 1;
			if (w == cv.width && h == cv.height) { cb(dataUrl); return; } // 已经是最小
			var cv2 = document.createElement('canvas');
			cv2.width = w; cv2.height = h;
			cv2.getContext('2d').drawImage(cv, minX, minY, w, h, 0, 0, w, h);
			cb(cv2.toDataURL('image/png'));
		};
		im.onerror = function () { cb(dataUrl); };
		im.src = dataUrl;
	}

	function importRes() {
		var inp = document.createElement('input');
		inp.type = 'file';
		inp.multiple = true;
		inp.accept = 'image/*';
		inp.onchange = function () {
			var files = inp.files;
			if (!files.length) return;
			var done = 0;
			for (var i = 0; i < files.length; i++) {
				(function (f) {
					var r = new FileReader();
					r.onload = function () {
						var name = f.name.replace(/\.[^.]+$/, '');
						var dup = 2;
						while (resources[name]) name = name + '_' + dup++;
						resources[name] = { type: 'img', data: r.result };
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

	$('btnImgRes').onclick = importRes;

	function renderResList() {
		var box = $('resList');
		box.innerHTML = '';
		var keys = Object.keys(resources);
		keys.forEach(function (k) {
			var row = el('div', 'resitem', box);
			var icon = el('span', '', row);
			icon.textContent = '[图]';
			var nm = el('span', '', row);
			nm.textContent = k;
			var trim = el('button', '', row);
			trim.textContent = '去透明';
			trim.title = '裁掉四周多余透明区域, 只留服装内容的最小矩形';
			trim.onclick = function () {
				trim.textContent = '处理中…';
				trimImage(resources[k].data, function (nd) {
					resources[k].data = nd;
					renderResList();
					renderPose();
				});
			};
			var del = el('button', '', row);
			del.textContent = '×';
			del.onclick = function () {
				delete resources[k];
				renderResList();
				refresh();
			};
		});
	}

	// ---------------- 新建/穿搭 ----------------

	function newCloth() {
		var maxId = 0;
		clothes.forEach(function (c) { if (c.id < 9000000 && c.id > maxId) maxId = c.id; });
		var tv = {};
		VALUE_KEYS.forEach(function (k) { tv[k] = { value: 5, name: k }; });
		var c = {
			type: '日常', id: maxId + 1,
			parts: [{ img: '', layer: '15', fix: { x: 0, y: 0 } }],
			type_style: [], money: 0, type_color: [],
			type_work: [], type_value: tv,
			rq: 0, name: '新服装', type_element: []
		};
		pushHistory();
		clothes.push(c);
		// 保留当前穿搭, 新衣服按冲突机制穿上
		dressOn(c.id);
		select(c.id, 0);
		renderLib();
	}

	// 新服装按钮 = 空体: 清掉当前穿搭, 只保留底层(身体/内衣/头发等)
	// 把当前改色预览烘焙成新服装: 图片逐件过canvas滤镜存为base64资源, 属性原样拷贝
	function applyRecolor() {
		var c = selId != null ? byId(selId) : null;
		if (!c || !recolor || recolor.id != c.id) return;
		var filter = 'hue-rotate(' + recolor.hue + 'deg) saturate(' + recolor.sat + '%) brightness(' + recolor.bri + '%)';
		var nc = JSON.parse(JSON.stringify(c));
		var maxId = 0;
		clothes.forEach(function (x) { if (x.id < 9000000 && x.id > maxId) maxId = x.id; });
		nc.id = maxId + 1;
		nc.name = (c.name || '未命名') + ' - edited';
		for (var i = 0; i < nc.parts.length; i++) {
			var p = nc.parts[i];
			if (!p.img) continue;
			var im = cacheImg(resolveSrc(p.img));
			if (!im || !im.complete || !im.naturalWidth) {
				alert('图片未加载完成, 请稍后再试');
				return;
			}
			var cv = document.createElement('canvas');
			cv.width = im.naturalWidth;
			cv.height = im.naturalHeight;
			var cx = cv.getContext('2d');
			cx.filter = filter;
			cx.drawImage(im, 0, 0);
			var url;
			try {
				url = cv.toDataURL('image/png');
			} catch (e) {
				alert('改色失败: ' + e.message);
				return;
			}
			var name = 'recolor_' + nc.id + '_' + i;
			resources[name] = { type: 'img', data: url };
			p.img = 'res:' + name;
		}
		pushHistory();
		clothes.push(nc);
		recolor = null;
		dressOn(nc.id);
		select(nc.id, 0);
		refresh();
	}

	$('btnNew').onclick = function () {
		outfit = [];
		selId = null; selPart = -1;
		refresh();
	};

	$('btnAddCloth').onclick = newCloth;

	$('btnDefault').onclick = function () {
		outfit = D.setting2.default_dress.map(Number);
		refresh();
	};

	// 下载官方身体底模, 方便玩家导入画图软件画服装
	$('btnModel').onclick = function () {
		fetch('assets/dress/img/shenti(fuse)/shentimoxing.png')
			.then(function (r) { return r.blob(); })
			.then(function (blob) {
				var url = URL.createObjectURL(blob);
				var a = document.createElement('a');
				a.href = url;
				a.download = 'shentimoxing.png';
				a.click();
				setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
			})
			.catch(function () {
				alert('底模下载失败');
			});
	};

	// ---------------- 导入/导出 ----------------

	// 导出穿搭JSON: 官方服装只引用id, 自定义服装内嵌完整属性+base64图片
	function exportJSON() {
		var title = prompt('搭配标题(用作文件名):', '我的穿搭');
		if (title === null) return;
		title = title.trim() || '我的穿搭';
		var outfitData = outfit.map(function (id) {
			if (OFFICIAL[id]) return { id: id };
			var c = byId(id);
			if (!c) return null;
			var clone = JSON.parse(JSON.stringify(c));
			clone.parts.forEach(function (p) {
				if (p.img && p.img.indexOf('res:') == 0) {
					var r = resources[p.img.slice(4)];
					p.img = r ? r.data : ''; // 自定义图片以base64嵌入
				}
			});
			return { cloth: clone };
		}).filter(Boolean);
		var data = { des: title, outfit: outfitData };
		var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
		var a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = title + '.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	// 导入: 支持 官方clothes.json / 之前导出的 {clothes} / 穿搭拓展JSON {outfit}
	function importJSONData(data) {
		if (data.outfit) {
			// 穿搭拓展JSON
			var newOutfit = [];
			var added = false;
			data.outfit.forEach(function (en) {
				if (en == null) return;
				if (typeof en == 'number' || en.id != null) {
					var id = en.id != null ? en.id : en;
					if (byId(id)) newOutfit.push(Number(id));
					return;
				}
				if (!en.cloth) return;
				var c = JSON.parse(JSON.stringify(en.cloth));
				// base64图片转回自定义资源
				c.parts.forEach(function (p, pi) {
					if (p.img && p.img.indexOf('data:') == 0) {
						var name = 'fan_' + c.id + '_' + pi;
						var dup = 2;
						while (resources[name]) name = 'fan_' + c.id + '_' + pi + '_' + dup++;
						resources[name] = { type: 'img', data: p.img };
						p.img = 'res:' + name;
					}
				});
				var old = byId(c.id);
				if (old) {
					clothes[clothes.indexOf(old)] = c;
					added = true;
				} else {
					clothes.push(c);
					added = true;
				}
				newOutfit.push(Number(c.id));
			});
			pushHistory();
			outfit = newOutfit;
			selId = null; selPart = -1;
			renderResList();
			refresh();
			return;
		}
		if (!data.clothes || !data.clothes.length) {
			alert('不是有效的服装 JSON (缺少 clothes 或 outfit)');
			return;
		}
		pushHistory();
		clothes = data.clothes;
		if (data.resources) {
			for (var k in data.resources) resources[k] = data.resources[k];
			renderResList();
		}
		outfit = outfit.filter(function (id) { return byId(id); });
		if (selId != null && !byId(selId)) { selId = null; selPart = -1; }
		refresh();
	}

	$('btnExport').onclick = exportJSON;

	$('btnImport').onclick = function () {
		var inp = document.createElement('input');
		inp.type = 'file';
		inp.accept = '.json';
		inp.onchange = function () {
			if (!inp.files[0]) return;
			var r = new FileReader();
			r.onload = function () {
				try {
					importJSONData(JSON.parse(r.result));
				} catch (e) {
					alert('JSON 解析失败: ' + e.message);
				}
			};
			r.readAsText(inp.files[0], 'utf-8');
		};
		inp.click();
	};

	// ?fan=xxx.json 从 fanmade 文件夹加载玩家穿搭
	var fanFile = new URLSearchParams(location.search).get('fan');
	if (fanFile) {
		fetch('assets/dress/fanmade/' + fanFile)
			.then(function (r) { return r.json(); })
			.then(function (data) {
				importJSONData(data);
			})
			.catch(function () {
				alert('加载玩家穿搭失败: ' + fanFile);
			});
	}

	// ---------------- 关于 ----------------

	$('btnAbout').onclick = function () { $('aboutBox').style.display = 'block'; };
	$('aboutClose').onclick = function () { $('aboutBox').style.display = 'none'; };
	$('aboutMask').onclick = function () { $('aboutBox').style.display = 'none'; };

	// ---------------- 刷新 ----------------

	function refresh() {
		renderPose();
		renderWearList();
		renderLib();
		renderProps();
	}

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

	fitStage();
	refresh();

	// 控制台调试用
	window.DRESSED = {
		get clothes() { return clothes; },
		get outfit() { return outfit; },
		get resources() { return resources; },
		importJSONData: importJSONData
	};
})();

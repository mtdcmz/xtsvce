var GAoEngine = (function () {
	'use strict';

	var STAGE_W = 800;
	var STAGE_H = 600;
	var LAYER_NAMES = ['bg', 'chara1', 'chara2', 'chara3', 'fore'];
	var TEXT_DELAY = 30; // 打字机速度, 原版gn.textDelay
	var FONT = '"Microsoft YaHei", SimSun, sans-serif';
	var OUTLINE = '#662d13';

	function clamp01(v) {
		return v < 0 ? 0 : (v > 1 ? 1 : v);
	}

	function replaceVars(str, vars) {
		return String(str).replace(/\{(\w+)\}/g, function (m, name) {
			return (vars && vars[name] != null) ? vars[name] : m;
		});
	}

	function resolveSrc(name, kind, env) {
		if (!name) return null;
		if (env.resources && env.resources[name]) return env.resources[name].data;
		var map = (kind == 'snd') ? env.assets.snds : env.assets.imgs;
		return (map && map[name]) ? map[name].src : null;
	}

	function easeOut(t) {
		return 1 - (1 - t) * (1 - t);
	}

	// 同src只加载一次
	function ImgCache() {
		this.map = {};
	}
	ImgCache.prototype.get = function (src) {
		if (!src) return null;
		if (!this.map[src]) {
			var im = new Image();
			im.src = src;
			this.map[src] = im;
		}
		return this.map[src];
	};

	function Layer(name) {
		this.name = name;
		this.img = null;
		this.src = '';
		this.x = 0;
		this.y = 0;
		this.scaleX = 1;
		this.scaleY = 1;
		this.alpha = 1;
		this.bright = 1;
		this.mirror = false;
		this.tween = null;
		this.shake = null;
		this.flash = null;
	}

	Layer.prototype.reset = function () {
		this.img = null;
		this.src = '';
		this.tween = null;
		this.shake = null;
		this.flash = null;
		this.x = 0;
		this.y = 0;
		this.scaleX = 1;
		this.scaleY = 1;
		this.alpha = 1;
		this.bright = 1;
		this.mirror = false;
	};

	Layer.prototype.cur = function (now) {
		if (!this.tween) return this;
		var t = (now - this.tween.t0) / this.tween.dur;
		if (t >= 1) {
			var to = this.tween.to;
			this.tween = null;
			this.x = to.x;
			this.y = to.y;
			this.scaleX = to.scaleX;
			this.scaleY = to.scaleY;
			this.alpha = to.alpha;
			this.bright = to.bright;
			return this;
		}
		var k = easeOut(t);
		var f = this.tween.from;
		return {
			x: f.x + (this.tween.to.x - f.x) * k,
			y: f.y + (this.tween.to.y - f.y) * k,
			scaleX: f.scaleX + (this.tween.to.scaleX - f.scaleX) * k,
			scaleY: f.scaleY + (this.tween.to.scaleY - f.scaleY) * k,
			alpha: f.alpha + (this.tween.to.alpha - f.alpha) * k,
			bright: f.bright + (this.tween.to.bright - f.bright) * k
		};
	};

	Layer.prototype.setProps = function (para, dur, now) {
		var target = {
			x: para.x || 0,
			y: para.y || 0,
			scaleX: para.scaleX != null ? para.scaleX : 1,
			scaleY: para.scaleY != null ? para.scaleY : 1,
			alpha: para.alpha != null ? para.alpha : 1,
			bright: para.bright != null ? para.bright : 1
		};
		if (dur > 0) {
			var c = this.cur(now);
			this.tween = {
				from: { x: c.x, y: c.y, scaleX: c.scaleX, scaleY: c.scaleY, alpha: c.alpha, bright: c.bright },
				to: target,
				t0: now,
				dur: dur
			};
		} else {
			this.tween = null;
			this.x = target.x;
			this.y = target.y;
			this.scaleX = target.scaleX;
			this.scaleY = target.scaleY;
			this.alpha = target.alpha;
			this.bright = target.bright;
		}
	};

	Layer.prototype.setImg = function (para, env, cache, now) {
		var src = resolveSrc(para.img, 'img', env);
		this.src = src || '';
		this.img = src ? cache.get(src) : null;
		this.mirror = !!para.mirrow;
		this.tween = null;
		this.setProps(para, 0, now);
	};

	Layer.prototype.moveImg = function (para, now) {
		this.setProps(para, para.transTime || 0, now);
	};

	// ShakeEffect: 每30ms换方向, 幅度按damping衰减, 小于0.5停
	Layer.prototype.stepShake = function (now, running) {
		var s = this.shake;
		if (!s) return;
		while (now >= s.next) {
			if (!running || (Math.abs(s.xf) < 0.5 && Math.abs(s.yf) < 0.5 && s.flag != 0)) {
				this.shake = null;
				return;
			}
			var sign = (s.flag % 2 == 0) ? 1 : -1;
			s.xf = sign * parseInt(s.xd * s.dampbuf);
			s.yf = sign * parseInt(s.yd * s.dampbuf);
			s.ox = s.xf;
			s.oy = s.yf;
			s.dampbuf *= s.damping;
			s.flag++;
			s.next += 30;
			if (s.next > now + 1000) s.next = now + 30;
		}
	};

	Layer.prototype.startShake = function (para) {
		this.shake = {
			xd: para.x != null ? para.x : 10,
			yd: para.y != null ? para.y : 0,
			damping: para.d != null ? para.d : 0.8,
			xf: 0,
			yf: 0,
			ox: 0,
			oy: 0,
			flag: 0,
			dampbuf: para.d != null ? para.d : 0.8,
			next: Date.now()
		};
	};

	// ---------------- 声音通道 ----------------
	function Channel() {
		this.audio = null;
		this.src = '';
	}

	Channel.prototype.play = function (para, env) {
		var src = resolveSrc(para.snd, 'snd', env);
		if (!src) return;
		if (this.audio && this.src == src && !this.audio.paused) {
			this.audio.volume = clamp01(para.volume != null ? para.volume : 1);
			return;
		}
		this.stop();
		this.src = src;
		this.audio = new Audio(src);
		this.audio.volume = clamp01(para.volume != null ? para.volume : 1);
		this.audio.loop = !!para.loop;
		this.audio.play();
	};

	Channel.prototype.setVolume = function (para) {
		if (this.audio) this.audio.volume = clamp01(para.volume != null ? para.volume : 1);
	};

	Channel.prototype.stop = function () {
		if (this.audio) {
			this.audio.pause();
			this.audio = null;
			this.src = '';
		}
	};

	// ---------------- 对话框 ----------------
	function Dialog(player) {
		this.player = player;
		this.reset();
	}

	Dialog.prototype.reset = function () {
		this.stopTimer();
		this.visible = false;
		this.alphaV = 0;
		this.alphaTween = null;
		this.nameText = '';
		this.nameVisible = false;
		this.lines = [];
		this.align = 'left';
		this.clickVisible = false;
		this.onDone = null;
		this.exps = null;
		this.flag = 0;
		this.format = [{}];
	};

	Dialog.prototype.curFormat = function () {
		return this.format[this.format.length - 1];
	};

	Dialog.prototype.newLine = function () {
		this.lines.push({ chars: [], align: this.align, w: 0 });
	};

	Dialog.prototype.print = function (str) {
		if (!this.lines.length) this.newLine();
		var f = this.curFormat();
		var color = f.color ? ('#' + f.color) : OUTLINE;
		var size = f.size || 22;
		var ctx = this.player.ctx;
		ctx.font = size + 'px ' + FONT;
		var line = this.lines[this.lines.length - 1];
		for (var i = 0; i < str.length; i++) {
			var ch = str.charAt(i);
			var w = ctx.measureText(ch).width;
			if (line.w + w > 662 && line.chars.length) {
				this.newLine();
				line = this.lines[this.lines.length - 1];
			}
			line.w += w;
			line.chars.push({ ch: ch, color: color, size: size });
		}
	};

	Dialog.prototype.show = function (done) {
		this.visible = true;
		if (this.alphaV < 1 && !this.alphaTween) {
			this.alphaTween = { from: this.alphaV, to: 1, t0: Date.now(), dur: 200, cb: done };
			return;
		}
		this.alphaV = 1;
		this.alphaTween = null;
		if (done) done();
	};

	Dialog.prototype.hide = function (done) {
		var self = this;
		if (this.alphaV > 0 && !this.alphaTween) {
			this.alphaTween = { from: this.alphaV, to: 0, t0: Date.now(), dur: 200, cb: function () {
				self.visible = false;
				if (done) done();
			} };
			return;
		}
		this.visible = this.alphaV > 0;
		this.alphaTween = null;
		if (done) done();
	};

	Dialog.prototype.setName = function (rawName, side) {
		if (!rawName) {
			this.nameVisible = false;
			return;
		}
		this.nameVisible = true;
		this.nameText = replaceVars(rawName, this.player.env.vars);
		this.nameSide = (side == 'right') ? 'right' : 'left';
	};

	// 原版分词: ]换成[再按[切开
	Dialog.prototype.parse = function (text) {
		text = replaceVars(text, this.player.env.vars);
		text = text.split(']').join('[');
		text = text.split('[[').join('[');
		var arr = text.split('[');
		if (!arr[arr.length - 1]) arr.pop();
		if (!arr[0]) arr.shift();
		return arr;
	};

	Dialog.prototype.runText = function (text, onDone) {
		this.exps = this.parse(text);
		this.flag = 0;
		this.format = [{}];
		// 原版: [cm]才清屏, 新对话接着上一段显示
		if (!this.lines.length) this.newLine();
		this.onDone = onDone;
		this.step();
	};

	// 预览用, 一次画完不等点击
	Dialog.prototype.renderInstant = function (text) {
		this.stopTimer();
		this.visible = true;
		this.alphaV = 1;
		this.alphaTween = null;
		this.nameVisible = false;
		this.clickVisible = false;
		this.format = [{}];
		this.lines = [];
		this.align = 'left';
		this.newLine();
		var arr = this.parse(text);
		for (var i = 0; i < arr.length; i++) {
			this.applyExp(arr[i], true);
		}
	};

	// 返回true表示这条exp挂起了(定时/点击/渐变), false表示直接过
	Dialog.prototype.applyExp = function (expStr, instant) {
		var eq = expStr.indexOf('=');
		var key = eq >= 0 ? expStr.substring(0, eq) : expStr;
		var para = eq >= 0 ? expStr.substring(eq + 1) : null;
		var self = this;
		switch (key) {
			case 'color':
				this.format.push({ color: para });
				break;
			case 'size':
				this.format.push({ size: parseInt(para) });
				break;
			case 'sizeEnd':
			case 'colorEnd':
			case 'alignEnd':
				if (this.format.length > 1) this.format.pop();
				break;
			case 'align':
				this.align = para;
				if (this.lines.length && !this.lines[this.lines.length - 1].chars.length) {
					this.lines[this.lines.length - 1].align = para;
				} else {
					this.newLine();
				}
				break;
			case 'wait':
				if (instant) break;
				this.timer = setTimeout(function () { self.end(); }, parseInt(para));
				return true;
			case 'l':
				if (instant) break;
				this.clickVisible = true;
				this.player.waitClick(function () {
					self.clickVisible = false;
					self.end();
				});
				return true;
			case 'cm':
				this.lines = [];
				this.newLine();
				this.format = [this.format[0]];
				break;
			case 'r':
				this.newLine();
				break;
			case 'show':
				if (instant) {
					this.visible = true;
					this.alphaV = 1;
					this.alphaTween = null;
					break;
				}
				this.show(function () { self.end(); });
				return true;
			case 'hide':
				if (instant) {
					this.visible = false;
					this.alphaV = 0;
					this.alphaTween = null;
					break;
				}
				this.hide(function () { self.end(); });
				return true;
			default:
				// 不是已知标记, 当普通文本原样输出(防正文里的=被当成key=参数切断)
				if (instant) this.print(expStr);
				else this.typeOut(expStr);
				return true;
		}
		return false;
	};

	Dialog.prototype.step = function () {
		if (this.flag >= this.exps.length) {
			this.complete();
			return;
		}
		if (!this.applyExp(this.exps[this.flag], false)) this.end();
	};

	Dialog.prototype.end = function () {
		this.flag++;
		this.step();
	};

	Dialog.prototype.complete = function () {
		var done = this.onDone;
		this.onDone = null;
		if (done) done();
	};

	Dialog.prototype.typeOut = function (str) {
		var chars = str.split('');
		var self = this;
		(function next() {
			if (!self.player.running) return;
			if (chars.length > 0) {
				self.print(chars.shift());
				self.timer = setTimeout(next, TEXT_DELAY);
			} else {
				self.end();
			}
		})();
	};

	Dialog.prototype.stopTimer = function () {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	};

	// ---------------- 剧本执行器 ----------------
	function Scripter(player) {
		this.player = player;
	}

	Scripter.prototype.play = function (exps, startIndex, onComplete) {
		this.exps = exps;
		this.flag = startIndex || 0;
		this.onComplete = onComplete;
		this.tagIndex = {};
		for (var i = 0; i < exps.length; i++) {
			if (exps[i].key == 'tag' && exps[i].para.tag) this.tagIndex[exps[i].para.tag] = i;
		}
		this.step();
	};

	Scripter.prototype.step = function () {
		if (this.flag < this.exps.length) {
			this.exp(this.exps[this.flag]);
		} else {
			this.complete();
		}
	};

	Scripter.prototype.gotoTag = function (tag) {
		if (tag in this.tagIndex) this.flag = this.tagIndex[tag];
		else this.flag = this.exps.length;
	};

	Scripter.prototype.end = function () {
		this.player.clickVisible = false;
		this.player.dialog.clickVisible = false;
		this.flag++;
		this.step();
	};

	Scripter.prototype.complete = function () {
		var cb = this.onComplete;
		this.onComplete = null;
		if (cb) cb();
	};

	Scripter.prototype.exp = function (exp) {
		var para = exp.para || {};
		var p = this.player;
		var self = this;
		switch (exp.key) {
			case 'tag':
				break;
			case 'setLayer':
				p.getLayer(para.layer).setImg(para, p.env, p.cache, Date.now());
				break;
			case 'moveLayer':
				p.getLayer(para.layer).moveImg(para, Date.now());
				break;
			case 'playSound':
				if (para.snd) {
					var ch = p.getChannel(para.channel || 'bgm');
					if (ch) ch.play(para, p.env);
				}
				break;
			case 'stopSound':
				var c2 = p.getChannel(para.channel || 'bgm');
				if (c2) c2.stop();
				break;
			case 'setSoundVolume':
				var c3 = p.getChannel(para.channel || 'bgm');
				if (c3) c3.setVolume(para);
				break;
			case 'top':
				p.bringToTop(para.layer);
				break;
			case 'flash':
				p.doFlash(para);
				break;
			case 'shake':
				if (para.layer == 'dialog') p.dialogShake = para;
				else p.getLayer(para.layer).startShake(para);
				break;
			case 'option':
				if (para.options && para.options.length > 0) {
					p.showOptions(para.options, function (tag) {
						self.gotoTag(tag);
						self.end();
					});
					return;
				}
				break;
			case 'jump':
				this.gotoTag(para.tag);
				break;
			case 'para':
			case 'event':
				break;
			case 'wait':
				if (para.type == 'program') break;
				if (para.type == 'click') {
					p.clickVisible = true;
					p.dialog.clickVisible = true;
					p.waitClick(function () { self.end(); });
					return;
				}
				if (parseInt(para.time) > 0) {
					p.delay(function () { self.end(); }, parseInt(para.time));
					return;
				}
				break;
			case 'text':
				p.runPara(para, function () { self.end(); });
				return;
			case 'end':
				this.complete();
				return;
		}
		this.end();
	};

	Scripter.prototype.stop = function () {
		this.onComplete = null;
	};

	// ---------------- 播放器主体 ----------------
	function Player(container, env) {
		this.env = env || {};
		this.env.vars = this.env.vars || {};
		this.env.assets = this.env.assets || { imgs: {}, snds: {} };
		this.env.resources = this.env.resources || {};
		this.running = false;
		this.cache = new ImgCache();
		this._scripter = null;

		this.root = document.createElement('div');
		this.root.className = 'gao-root';
		container.appendChild(this.root);

		this.canvas = document.createElement('canvas');
		this.canvas.width = STAGE_W;
		this.canvas.height = STAGE_H;
		this.canvas.className = 'gao-canvas';
		this.root.appendChild(this.canvas);
		this.ctx = this.canvas.getContext('2d');

		this.layerOrder = LAYER_NAMES.slice();
		this.layers = {};
		for (var i = 0; i < LAYER_NAMES.length; i++) {
			this.layers[LAYER_NAMES[i]] = new Layer(LAYER_NAMES[i]);
		}

		this.channels = { bgm: new Channel() };
		this.dialog = new Dialog(this);

		this.highlight = null; // 编辑器选中的图层
		this.clickVisible = false;
		this.dialogShake = null;
		this.options = null;
		this.flashFx = null;
		this.clickWaitCb = null;
		this.timers = [];

		var self = this;
		this.tap = function (x, y) {
			if (self.options) {
				for (var i = 0; i < self.options.list.length; i++) {
					var b = self.optionRect(i);
					if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
						var cb = self.options.cb;
						var tag = self.options.list[i].tag;
						self.options = null;
						cb(tag);
						return;
					}
				}
				return;
			}
			if (self.clickWaitCb) {
				var cb2 = self.clickWaitCb;
				self.clickWaitCb = null;
				cb2();
			}
		};
		this.stageXY = function (e) {
			var rect = self.canvas.getBoundingClientRect();
			return {
				x: (e.clientX - rect.left) / (rect.width / STAGE_W),
				y: (e.clientY - rect.top) / (rect.height / STAGE_H)
			};
		};
		this.canvas.addEventListener('mousedown', function (e) {
			var pt = self.stageXY(e);
			self.tap(pt.x, pt.y);
		});
		this.canvas.addEventListener('touchstart', function (e) {
			if (!self.options && !self.clickWaitCb) return;
			e.preventDefault();
			var pt = self.stageXY(e.changedTouches[0]);
			self.tap(pt.x, pt.y);
		}, { passive: false });

		this.keyHandler = function (e) {
			if (!self.running) return;
			if (e.keyCode == 32 || e.keyCode == 13) {
				if (self.clickWaitCb) {
					e.preventDefault();
					var cb = self.clickWaitCb;
					self.clickWaitCb = null;
					cb();
				}
			} else if (e.keyCode == 27) {
				self.stop();
			}
		};
		document.addEventListener('keydown', this.keyHandler);

		var self = this;
		var loop = function () {
			if (self.dead) return; // 销毁后停止循环, 不然越开越卡
			self.draw();
			requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
	}

	Player.prototype.getLayer = function (name) {
		return this.layers[name] || this.layers.bg;
	};

	Player.prototype.getChannel = function (name) {
		return this.channels[name] || this.channels.bgm;
	};

	Player.prototype.bringToTop = function (name) {
		var idx = this.layerOrder.indexOf(name);
		if (idx >= 0) {
			this.layerOrder.splice(idx, 1);
			this.layerOrder.push(name);
		}
	};

	Player.prototype.delay = function (fn, ms) {
		var t = setTimeout(fn, ms);
		this.timers.push(t);
		return t;
	};

	Player.prototype.waitClick = function (cb) {
		this.clickWaitCb = cb;
	};

	Player.prototype.doFlash = function (para) {
		this.flashFx = {
			color: para.color ? ('#' + String(para.color).replace('#', '')) : '#ffffff',
			t0: Date.now(),
			dur: para.time || 300
		};
	};

	Player.prototype.showOptions = function (options, cb) {
		this.options = { list: options, cb: cb };
	};

	Player.prototype.optionRect = function (i) {
		return { x: 300, y: 200 + i * 46, w: 200, h: 36 };
	};

	Player.prototype.runPara = function (para, done) {
		this.dialog.setName(para.charaName, para.nameSide);
		this.dialog.runText(para.text, done);
	};

	// 预览时直接摆一句话上舞台
	Player.prototype.dialogInstant = function (name, side, text) {
		this.dialog.renderInstant(text);
		this.dialog.setName(name, side);
	};

	Player.prototype.resetVisuals = function () {
		this.clearTimers();
		this.clickWaitCb = null;
		this.clickVisible = false;
		for (var k in this.layers) this.layers[k].reset();
		for (var c in this.channels) this.channels[c].stop();
		this.dialog.reset();
		this.dialogShake = null;
		this.options = null;
		this.flashFx = null;
	};

	Player.prototype.stopVisuals = function () {
		this.clearTimers();
		this.clickWaitCb = null;
		this.clickVisible = false;
		this.dialog.stopTimer();
		for (var c in this.channels) this.channels[c].stop();
		this.options = null;
	};

	Player.prototype.clearTimers = function () {
		for (var i = 0; i < this.timers.length; i++) clearTimeout(this.timers[i]);
		this.timers = [];
	};

	Player.prototype.stop = function () {
		this.running = false;
		if (this._scripter) this._scripter.stop();
		this.stopVisuals();
	};

	Player.prototype.play = function (exps, startIndex, onFinish) {
		var self = this;
		this.stop();
		this.running = true;
		this.onFinish = onFinish;
		this.resetVisuals();
		this._scripter = new Scripter(this);
		// 原版是先preload再播的, 不然切图会闪
		this.preload(exps, function () {
			if (!self.running) return;
			if (startIndex > 0) {
				// 中途开播, 先把前面铺到这个进度
				self.applyState(exps, startIndex, true);
			}
			self._scripter.play(exps, startIndex || 0, function () {
				self.running = false;
				self.stopVisuals();
				if (self.onFinish) self.onFinish();
			});
		});
	};

	Player.prototype.preload = function (exps, cb) {
		var srcs = {};
		for (var i = 0; i < exps.length; i++) {
			var p = exps[i].para || {};
			var s = null;
			if ((exps[i].key == 'setLayer' || exps[i].key == 'moveLayer') && p.img) {
				s = resolveSrc(p.img, 'img', this.env);
			} else if (exps[i].key == 'playSound' && p.snd) {
				s = resolveSrc(p.snd, 'snd', this.env);
			}
			if (s) srcs[s] = true;
		}
		var list = Object.keys(srcs);
		var self = this;
		if (!list.length) {
			cb();
			return;
		}
		var left = list.length;
		var fin = function () {
			left--;
			if (left <= 0 && self.running) cb();
		};
		for (var j = 0; j < list.length; j++) {
			(function (src) {
				if (/\.(mp3|wav|ogg|m4a)($|\?)/i.test(src) || src.indexOf('data:audio') == 0) {
					// 音乐不用等它
					var a = new Audio();
					a.preload = 'auto';
					a.src = src;
					a.load();
					fin();
					return;
				}
				var im = self.cache.get(src);
				if (im.complete) {
					fin();
					return;
				}
				im.onload = im.onerror = fin;
			})(list[j]);
		}
	};

	// 把画面快进到第n条exp, withSound时顺带把BGM也续上
	Player.prototype.applyState = function (exps, uptoCount, withSound) {
		var lastSound = null;
		for (var i = 0; i < uptoCount && i < exps.length; i++) {
			var exp = exps[i];
			var para = exp.para || {};
			if (exp.key == 'setLayer') {
				this.getLayer(para.layer).setImg(para, this.env, this.cache, Date.now());
			} else if (exp.key == 'moveLayer') {
				// 铺垫状态不播动画, 直接落定, 不然拖拽时会闪
				var p2 = {};
				for (var k in para) p2[k] = para[k];
				p2.transTime = 0;
				this.getLayer(para.layer).moveImg(p2, Date.now());
			} else if (exp.key == 'top') {
				this.bringToTop(para.layer);
			} else if (exp.key == 'playSound' && para.snd) {
				lastSound = para;
			} else if (exp.key == 'stopSound') {
				lastSound = null;
			}
		}
		if (withSound && lastSound) {
			var ch = this.getChannel(lastSound.channel || 'bgm');
			if (ch) ch.play(lastSound, this.env);
		}
	};

	Player.prototype.preview = function (exps, uptoCount) {
		this.stop();
		this.resetVisuals();
		this.applyState(exps, uptoCount, false);
	};

	Player.prototype.destroy = function () {
		this.dead = true;
		this.stop();
		document.removeEventListener('keydown', this.keyHandler);
		if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
	};

	// ---------------- 渲染 ----------------
	Player.prototype.draw = function () {
		var ctx = this.ctx;
		var now = Date.now();
		var r = this.drawRatio || 1;
		ctx.setTransform(r, 0, 0, r, 0, 0);
		ctx.globalAlpha = 1;
		ctx.filter = 'none';
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, STAGE_W, STAGE_H);

		for (var i = 0; i < this.layerOrder.length; i++) {
			var l = this.layers[this.layerOrder[i]];
			l.stepShake(now, this.running);
			this.drawLayer(l);
		}

		var d = this.dialog;
		if (d.alphaTween) {
			var t = (now - d.alphaTween.t0) / d.alphaTween.dur;
			if (t >= 1) {
				d.alphaV = d.alphaTween.to;
				var cb = d.alphaTween.cb;
				d.alphaTween = null;
				d.visible = d.alphaV > 0;
				if (cb) cb();
			} else {
				d.alphaV = d.alphaTween.from + (d.alphaTween.to - d.alphaTween.from) * easeOut(t);
			}
		}
		if (d.visible || d.alphaV > 0) this.drawDialog(d);

		if (this.options) this.drawOptions();

		if (this.flashFx) {
			var ft = (now - this.flashFx.t0) / this.flashFx.dur;
			if (ft >= 1) {
				this.flashFx = null;
			} else {
				ctx.globalAlpha = 1 - ft;
				ctx.fillStyle = this.flashFx.color;
				ctx.fillRect(0, 0, STAGE_W, STAGE_H);
				ctx.globalAlpha = 1;
			}
		}

		if (this.highlight && !this.running) {
			var hl = this.layers[this.highlight];
			if (hl && hl.img && hl.img.complete && hl.alpha > 0) {
				var st = hl.cur(now);
				ctx.setLineDash([4, 3]);
				ctx.strokeStyle = '#ff8888';
				ctx.lineWidth = 1;
				ctx.strokeRect(st.x + 0.5, st.y + 0.5, hl.img.width * (st.scaleX || 1), hl.img.height * (st.scaleY || 1));
				ctx.setLineDash([]);
			}
		}
	};

	Player.prototype.drawLayer = function (l) {
		var ctx = this.ctx;
		var now = Date.now();
		var st = l.cur(now);
		if (!l.img || !l.img.complete || st.alpha <= 0) return;
		ctx.save();
		ctx.globalAlpha = clamp01(st.alpha);
		var ox = l.shake ? l.shake.ox : 0;
		var oy = l.shake ? l.shake.oy : 0;
		ctx.translate(st.x + ox, st.y + oy);
		ctx.scale(st.scaleX || 1, st.scaleY || 1);
		if (l.mirror) {
			ctx.translate(l.img.width, 0);
			ctx.scale(-1, 1);
		}
		ctx.filter = 'brightness(' + (st.bright != null ? st.bright : 1) + ')';
		ctx.drawImage(l.img, 0, 0);
		ctx.restore();
	};

	Player.prototype.drawDialog = function (d) {
		var ctx = this.ctx;
		ctx.save();
		ctx.globalAlpha = clamp01(d.alphaV);

		if (this.dialogShake && this.running) {
			var ds = this.dialogShake;
			ctx.translate((Math.random() * 2 - 1) * (ds.x || 8), (Math.random() * 2 - 1) * (ds.y || 8));
		}

		var back = this.cache.get('assets/gameui/back.png');
		if (back && back.complete) ctx.drawImage(back, 50, 432, 703, 159);

		if (d.nameVisible) {
			var nx = (d.nameSide == 'right') ? 594 : 90;
			var name = this.cache.get('assets/gameui/name.png');
			if (name && name.complete) ctx.drawImage(name, nx, 414, 134, 36);
			ctx.font = '21px ' + FONT;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.lineWidth = 3;
			ctx.lineJoin = 'round';
			ctx.strokeStyle = OUTLINE;
			ctx.fillStyle = '#fff';
			ctx.strokeText(d.nameText, nx + 67, 433);
			ctx.fillText(d.nameText, nx + 67, 433);
		}

		ctx.save();
		ctx.beginPath();
		ctx.rect(73, 462, 662, 96);
		ctx.clip();
		ctx.textBaseline = 'alphabetic';
		for (var i = 0; i < d.lines.length; i++) {
			var line = d.lines[i];
			if (!line.chars.length) continue;
			var y = 462 + i * 32 + 24;
			if (y > 558) break;
			var lx = 73;
			if (line.align != 'left') {
				var lw = 0;
				for (var c = 0; c < line.chars.length; c++) {
					ctx.font = line.chars[c].size + 'px ' + FONT;
					lw += ctx.measureText(line.chars[c].ch).width;
				}
				lx = (line.align == 'center') ? (73 + (662 - lw) / 2) : (735 - lw);
			}
			for (var j = 0; j < line.chars.length; j++) {
				var ch = line.chars[j];
				ctx.font = ch.size + 'px ' + FONT;
				ctx.textAlign = 'left';
				ctx.lineWidth = 2.5;
				ctx.lineJoin = 'round';
				ctx.strokeStyle = '#ffffff';
				ctx.fillStyle = ch.color;
				ctx.strokeText(ch.ch, lx, y);
				ctx.fillText(ch.ch, lx, y);
				lx += ctx.measureText(ch.ch).width;
			}
		}
		ctx.restore();

		if (d.clickVisible) {
			var cont = this.cache.get('assets/gameui/continue.png');
			if (cont && cont.complete) ctx.drawImage(cont, 637, 548, 90, 26);
		}
		ctx.restore();
	};

	Player.prototype.drawOptions = function () {
		var ctx = this.ctx;
		for (var i = 0; i < this.options.list.length; i++) {
			var b = this.optionRect(i);
			ctx.fillStyle = 'rgba(255,252,246,0.95)';
			ctx.strokeStyle = '#d8a8a0';
			ctx.lineWidth = 1;
			ctx.fillRect(b.x, b.y, b.w, b.h);
			ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
			ctx.font = '16px ' + FONT;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillStyle = '#6b3a1f';
			ctx.fillText(this.options.list[i].text, b.x + b.w / 2, b.y + b.h / 2 + 1);
		}
	};

	var GAoEngine = {
		create: function (container, env) {
			return new Player(container, env);
		},
		replaceVars: replaceVars,
		resolveSrc: resolveSrc,
		STAGE_W: STAGE_W,
		STAGE_H: STAGE_H
	};

	return GAoEngine;
})();

// 商品写真のアップロード共通部品
// 写真ファイルを選ぶと、ブラウザの中で自動的に縮小・圧縮（JPEG）してから保存します。
// そのままの大きな写真は送らないので、スマホの写真でも大丈夫です。

function processImageFile(file) {
  return new Promise(function (resolve, reject) {
    if (!file || !/^image\//.test(file.type)) {
      reject(new Error("画像ファイルを選んでください"));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      let max = 1000;
      let quality = 0.82;
      function render() {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL("image/jpeg", quality);
      }
      let data = render();
      if (data.length > 1100000) {
        max = 800;
        quality = 0.62;
        data = render();
      }
      if (data.length > 1100000) {
        reject(new Error("写真が大きすぎます。別の写真をお試しください"));
        return;
      }
      resolve(data);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("写真を読み込めませんでした"));
    };
    img.src = url;
  });
}

// 写真フィールド（ファイル選択＋プレビュー＋URL入力＋削除）を作る部品。
// 使い方：const photo = createPhotoField(今の画像); 親要素.appendChild(photo.element);
// 保存するときは photo.getValue() を image として送る。
function createPhotoField(initialImage) {
  let value = initialImage || "";

  const wrap = document.createElement("div");

  const preview = document.createElement("img");
  preview.alt = "商品写真のプレビュー";
  preview.style.cssText = "display:none;width:100%;max-height:200px;object-fit:cover;border-radius:8px;border:1px solid #e3dcc9;margin:6px 0";
  if (value) {
    preview.src = value;
    preview.style.display = "block";
  }
  wrap.appendChild(preview);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  wrap.appendChild(fileInput);

  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "または画像のURL（https://…）";
  urlInput.maxLength = 500;
  urlInput.style.marginTop = "8px";
  if (value && /^https?:\/\//.test(value)) urlInput.value = value;
  wrap.appendChild(urlInput);

  const row = document.createElement("div");
  row.style.marginTop = "8px";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "small-btn";
  clearBtn.textContent = "写真を削除";
  row.appendChild(clearBtn);
  wrap.appendChild(row);

  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "スマホ・パソコンから写真を選ぶと、自動で縮小して保存されます。";
  wrap.appendChild(note);

  const msg = document.createElement("p");
  msg.className = "msg";
  wrap.appendChild(msg);

  fileInput.addEventListener("change", function () {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    msg.className = "msg";
    msg.textContent = "写真を処理しています…";
    processImageFile(file)
      .then(function (data) {
        value = data;
        preview.src = data;
        preview.style.display = "block";
        urlInput.value = "";
        msg.className = "msg ok";
        msg.textContent = "写真をセットしました。保存すると反映されます。";
      })
      .catch(function (e) {
        msg.className = "msg error";
        msg.textContent = e.message || "写真を読み込めませんでした";
      });
  });

  urlInput.addEventListener("change", function () {
    const v = urlInput.value.trim();
    value = v;
    if (v) {
      preview.src = v;
      preview.style.display = "block";
    } else {
      preview.style.display = "none";
    }
    msg.textContent = "";
  });

  function reset() {
    value = "";
    fileInput.value = "";
    urlInput.value = "";
    preview.style.display = "none";
    preview.removeAttribute("src");
    msg.textContent = "";
  }

  clearBtn.addEventListener("click", reset);

  return { element: wrap, getValue: function () { return value; }, reset: reset };
}

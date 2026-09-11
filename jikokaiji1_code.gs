/* ============================================================
   婚活自己開示QA Part1 – GAS バックエンド (Code.gs)
   スプレッドシート名（想定）: konkatsuapp_jikokaiji_qa1_sheet
   ------------------------------------------------------------
   ・Shares    シート : 共有用の暗号化済み回答（本人／初回閲覧者のみ復号可）
   ・Analytics シート : 統計集計に必要な項目のみを平文で保存
   ------------------------------------------------------------
   デプロイ方法:
   1. 対象スプレッドシートを開き「拡張機能 > Apps Script」でこの
      コードを貼り付ける。
   2. 下記 SPREADSHEET_ID に、このスプレッドシートのIDを設定する
      （コンテナバインド型スクリプトの場合は
       SpreadsheetApp.getActiveSpreadsheet() でも可）。
   3. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」
      - 実行するユーザー: 自分
      - アクセスできるユーザー: 全員
      でデプロイし、発行された /exec の URL を app.js の
      GAS_ENDPOINT に設定する。
   ============================================================ */

var SPREADSHEET_ID   = '1Z1JGoWIBh0VqxVCeFph_O4PZIEMYAKj66I2Nx69zDLY'; 
var SHARES_SHEET      = 'Shares';
var ANALYTICS_SHEET   = 'Analytics';
var SCHEMA_VERSION    = 1;

// Shares シートの列番号（1-indexed）
var COL = {
  ID: 1, CIPHER_TEXT: 2, ENCRYPTED_KEY: 3, OWNER_HASH: 4, VIEWER_HASH: 5,
  STATUS: 6, SCHEMA_VERSION: 7, CREATED_AT: 8, UPDATED_AT: 9,
  FIRST_VIEWED_AT: 10, LAST_VIEWED_AT: 11, VIEW_COUNT: 12
};

// Analytics シートの列番号（1-indexed）
// ※このスプレッドシートは1行目=見出しのみ（説明行なし）のため、
//   DATA_START_ROW は 2 から開始する。
// 実際のシート列順（ヘッダー行そのまま）: id, ownerHash, viewerHash, createdAt,
// serious_relationship_status, partner_hash, serious_relationship_started_at, serious_relationship_ended_at,
// q1-1, q1-2, q2, q3, q3Detail, q4, q6, q6Detail, q7, q8, q9, q10, q11, q12, q13, q14-1, q14-2, q15
// ※列名はHTML/app.js側の画面表示Q番号に合わせてある（あだ名＝画面Q5は列自体が存在しない）。
var ACOL = {
  ID: 1, OWNER_HASH: 2, VIEWER_HASH: 3, CREATED_AT: 4,
  SERIOUS_RELATIONSHIP_STATUS: 5, PARTNER_HASH: 6,
  SERIOUS_RELATIONSHIP_STARTED_AT: 7, SERIOUS_RELATIONSHIP_ENDED_AT: 8,
  Q1_1: 9, Q1_2: 10, Q2: 11, Q3: 12, Q3_DETAIL: 13, Q4: 14,
  Q6: 15, Q6_DETAIL: 16, Q7: 17, Q8: 18, Q9: 19, Q10: 20, Q11: 21, Q12: 22, Q13: 23,
  Q14_1: 24, Q14_2: 25, Q15: 26
};

var DATA_START_ROW = 2; // 1行目=見出し, 2行目以降がデータ

/* ------------------------------------------------------------
   真剣交際パートナー機能連携（Partners中央API）
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URLを設定
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';

/* 指定ownerHashの現在の真剣交際ステータスをPartners APIに問い合わせる。
   ・ active: true  → viewerHash が partnerHash と一致する場合のみ閲覧許可
   ・ everPartnered: true（かつ active:false）→ 過去に交際していたが現在は
     パートナー不在（交際終了後など）。本人以外は誰にも見せない。
   ・ 両方 false → 従来通り「初回閲覧者固定」ロジックを使う
   結果は900秒（15分）キャッシュし、Partners API不通時は「everPartnered:false」
   として従来ロジックにフォールバックする（閲覧を過剰にブロックしないため）。
   ※以前は120秒キャッシュだったため、閲覧のたびに別GASへの外部fetchが頻発し、
     それがコールドスタート等と重なって体感速度を落とす主因になっていた。
     交際ステータスはリアルタイム性がそこまで重要ではないため、キャッシュを
     延ばして外部呼び出し頻度を大きく減らす。 */
var PARTNER_STATUS_CACHE_SECONDS = 900;

function getPartnerStatus(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { active: false, everPartnered: false, partnerHash: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || ''
      };
    }
  } catch (err) {
    // Partners APIが不通の場合は従来ロジックにフォールバック（ログのみ残す）
    Logger.log('getPartnerStatus failed: ' + err);
  }
  cache.put(cacheKey, JSON.stringify(result), PARTNER_STATUS_CACHE_SECONDS);
  return result;
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'view') {
      return handleView(e.parameter.id, e.parameter.viewerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'share') {
      return handleShare(body);
    }
    if (body.action === 'syncPartnerStatus') {
      return handleSyncPartnerStatus(body);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}


/* ------------------------------------------------------------
   共有登録（回答の保存）
   ・cipherText はクライアント側で AES-GCM 暗号化済みのため、
     このサーバー（および管理者）は復号鍵を一切受け取らない。
   ・Analytics: 同じ ownerHash（同一LINEアカウント）から再度共有
     された場合、以前の行を削除したうえで新しい行を追加する
     （＝完全上書き。1人1行に統一される）。
   ・Shares: 同じ ownerHash の既存行のうち、まだ誰にも開かれて
     いない（VIEWER_HASH が空の）行だけを上書き（削除→新規追加）。
     すでに誰かが開いた行は履歴として残し、新しい行を追加する。
     つまり「誰かが開くまでは上書き、開いたら次回は新規行」。
   ------------------------------------------------------------ */
function handleShare(body) {
  var id         = body.id;
  var cipherText = body.cipherText;
  var ownerHash  = body.ownerHash;
  var analytics  = body.analytics || {};

  if (!id || !cipherText || !ownerHash) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet();
    var sharesSheet    = ss.getSheetByName(SHARES_SHEET);
    var analyticsSheet = ss.getSheetByName(ANALYTICS_SHEET);
    var now = new Date();

    var shareRow = [
      id, cipherText, '', ownerHash, '', 'active', SCHEMA_VERSION,
      now, now, '', '', 0
    ];
    upsertUnviewedShareRow(sharesSheet, ownerHash, shareRow);

    var analyticsRow = [
      id, ownerHash, '', now,
      '', '', '', '', // SERIOUS_RELATIONSHIP_STATUS / PARTNER_HASH / STARTED_AT / ENDED_AT（初期値は空。Partners側からsyncPartnerStatusで後から更新）
      analytics['q1-1'] || '', analytics['q1-2'] || '', analytics.q2 || '',
      analytics.q3 || '', analytics.q3Detail || '', analytics.q4 || '',
      analytics.q6 || '', analytics.q6Detail || '',
      analytics.q7 || '', analytics.q8 || '', analytics.q9 || '', analytics.q10 || '',
      analytics.q11 || '', analytics.q12 || '', analytics.q13 || '',
      analytics['q14-1'] || '', analytics['q14-2'] || '', analytics.q15 || ''
    ];
    upsertAnalyticsRow(analyticsSheet, ownerHash, analyticsRow);

    return jsonResponse({ ok: true, id: id });
  } finally {
    lock.releaseLock();
  }
}

/* 同じ ownerHash の Shares 行のうち、まだ誰にも開かれていない
   （VIEWER_HASH が空の）行があれば、その行をそのまま上書きする
   （＝1回のsetValuesで完結。deleteRow+appendRowより大幅に軽い）。
   該当行が無ければ新規行として追加する。
   ・誰にも開かれていない行 → 上書き対象
   ・すでに誰かが開いた行   → 履歴として残す（対象にしない）
   これにより「最初に誰かが開くまでは上書き、開いたら次は新規行」という
   挙動は変えずに、行の削除・シフトを発生させない。
   ※通常運用では該当行は0または1件のみのはず（複数残る場合は最初の
     1件だけを上書きし、残りは履歴として残る）。 */
function upsertUnviewedShareRow(sheet, ownerHash, rowValues) {
  var lastRow = sheet.getLastRow();
  var targetRow = null;
  if (lastRow >= DATA_START_ROW) {
    var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COL.VIEWER_HASH).getValues();
    for (var i = 0; i < values.length; i++) {
      var rowOwnerHash  = values[i][COL.OWNER_HASH - 1];
      var rowViewerHash = values[i][COL.VIEWER_HASH - 1];
      if (rowOwnerHash === ownerHash && !rowViewerHash) {
        targetRow = DATA_START_ROW + i;
        break;
      }
    }
  }
  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}

/* 同じ ownerHash の既存 Analytics 行があれば上書きし、無ければ新規追加する
   （統計の重複防止。1人1行を維持しつつ deleteRow を使わない）。 */
function upsertAnalyticsRow(sheet, ownerHash, rowValues) {
  var targetRow = findAnalyticsRowByOwnerHash(sheet, ownerHash);
  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
}


/* ------------------------------------------------------------
   閲覧（共有リンクを開いたとき）
   アクセス制御:
   ・本人（ownerHash と一致） → 常に許可
   ・viewerHash が未登録      → この人を初回閲覧者として登録し許可
   ・viewerHash が登録済み    → 一致すれば許可、不一致なら拒否
   ------------------------------------------------------------ */
function handleView(id, viewerHash) {
  if (!id) return jsonResponse({ ok: false, reason: 'invalid_params' });
  if (!viewerHash) return jsonResponse({ ok: false, reason: 'login_required' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSpreadsheet().getSheetByName(SHARES_SHEET);
    var rowIndex = findRowById(sheet, id);
    if (!rowIndex) return jsonResponse({ ok: false, reason: 'not_found' });

    var row = sheet.getRange(rowIndex, 1, 1, COL.VIEW_COUNT).getValues()[0];
    var cipherText       = row[COL.CIPHER_TEXT - 1];
    var ownerHash         = row[COL.OWNER_HASH - 1];
    var existingViewerHash = row[COL.VIEWER_HASH - 1];
    var status            = row[COL.STATUS - 1];

    if (status !== 'active') {
      return jsonResponse({ ok: false, reason: status === 'active' ? 'not_found' : status });
    }

    var now = new Date();
    var allowed = false;
    var isFirstView = false;
    var partnerInfo = getPartnerStatus(ownerHash);

    if (viewerHash === ownerHash) {
      allowed = true;
    } else if (partnerInfo.active) {
      // 真剣交際中: パートナー以外は、過去の初回閲覧者であっても不可
      allowed = (viewerHash === partnerInfo.partnerHash);
    } else if (partnerInfo.everPartnered) {
      // 過去に真剣交際していたが現在パートナー不在（交際終了後など）: 本人以外は不可
      allowed = false;
    } else if (!existingViewerHash) {
      allowed = true;
      isFirstView = true;
      sheet.getRange(rowIndex, COL.VIEWER_HASH).setValue(viewerHash);
      sheet.getRange(rowIndex, COL.FIRST_VIEWED_AT).setValue(now);
      updateAnalyticsViewerHash(id, viewerHash);
    } else if (existingViewerHash === viewerHash) {
      allowed = true;
    } else {
      allowed = false;
    }

    if (!allowed) {
      return jsonResponse({ ok: false, reason: (partnerInfo.active || partnerInfo.everPartnered) ? 'partner_locked' : 'forbidden' });
    }

    sheet.getRange(rowIndex, COL.LAST_VIEWED_AT).setValue(now);
    var viewCountCell = sheet.getRange(rowIndex, COL.VIEW_COUNT);
    viewCountCell.setValue((Number(viewCountCell.getValue()) || 0) + 1);

    return jsonResponse({ ok: true, cipherText: cipherText });
  } finally {
    lock.releaseLock();
  }
}

function updateAnalyticsViewerHash(id, viewerHash) {
  var sheet = getSpreadsheet().getSheetByName(ANALYTICS_SHEET);
  var rowIndex = findRowById(sheet, id);
  if (rowIndex) sheet.getRange(rowIndex, ACOL.VIEWER_HASH).setValue(viewerHash);
}

/* ------------------------------------------------------------
   Partners APIからの真剣交際ステータス同期
   ・secretが一致しない呼び出しは拒否（Partners以外からの
     書き換えを防ぐ、サーバー間限定エンドポイント）
   ・該当ownerHashのAnalytics行が無い（このミニアプリ未回答）
     場合は何もせず ok:true, skipped:true を返す
   ------------------------------------------------------------ */
function handleSyncPartnerStatus(body) {
  if (!INTERNAL_SECRET || body.secret !== INTERNAL_SECRET) {
    return jsonResponse({ ok: false, reason: 'forbidden' });
  }
  var ownerHash = body.ownerHash;
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSpreadsheet().getSheetByName(ANALYTICS_SHEET);
    var rowIndex = findAnalyticsRowByOwnerHash(sheet, ownerHash);
    if (!rowIndex) return jsonResponse({ ok: true, skipped: true });

    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_STATUS).setValue(body.status || '');
    sheet.getRange(rowIndex, ACOL.PARTNER_HASH).setValue(body.partnerHash || '');
    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_STARTED_AT).setValue(body.startedAt || '');
    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_ENDED_AT).setValue(body.endedAt || '');
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/* Analyticsシート上で ownerHash が一致する行を探す（見つからなければ null） */
function findAnalyticsRowByOwnerHash(sheet, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, ACOL.OWNER_HASH).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][ACOL.OWNER_HASH - 1] === ownerHash) return DATA_START_ROW + i;
  }
  return null;
}

/* id (A列) からデータ行番号を探す。見つからなければ null */
function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var ids = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return DATA_START_ROW + i;
  }
  return null;
}

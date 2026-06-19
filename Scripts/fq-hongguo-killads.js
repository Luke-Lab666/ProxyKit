/*
 * 番茄小说 + 红果短剧广告硬清理
 * Aggressive Version
 */

const url = $request.url;
let body = $response.body;

if (!body) $done({});

const urlBad = /ad|ads|advert|splash|launch|open_screen|reward|inspire|commercial|promotion|popup|float|pendant|benefit|welfare|task|coin|gold|cash|bonus|red_packet|hongbao|lottery|mall|minigame|mini_game|wallet|pangolin|pangle|gromore|union_ad/i;

const keyBad = /(^|_|-|\b)(ad|ads|advert|advertise|advertisement|splash|launch|open_screen|feed_ad|reward|reward_ad|inspire|inspire_ad|commercial|promotion|popup|pop_up|float|floating|pendant|benefit|welfare|task|coin|gold|cash|bonus|red_packet|hongbao|lottery|mall|game|minigame|mini_game|wallet|pangle|pangolin|gromore|union_ad|raw_ad|creative|material|landing|lynx|coupon)(_|-|\b|$)/i;

const textBad = /(广告|开屏|章末广告|底部广告|听书广告|激励|激励视频|看视频|免广告|福利|福利中心|金币|金豆|任务|每日任务|赚钱|提现|现金|红包|领现金|悬浮|挂件|弹窗|小游戏|商城|抽奖|签到|看剧赚钱|边看边赚|红包雨|活动入口|会员推广|充值优惠)/;

const boolFalse = /^(show_ad|has_ad|is_ad|need_ad|enable_ad|ad_enable|ad_enabled|show_ads|has_ads|need_ads|enable_ads|can_show_ad|display_ad|show_splash|show_popup|show_float|show_pendant|show_welfare|show_benefit|show_coin|show_task|show_reward|show_inspire|is_commercial|is_ad_video|need_login_ad|enable_commercial)$/i;

const numZero = /^(ad_count|ads_count|ad_num|ad_time|ad_interval|splash_interval|reward_count|coin_amount|gold_amount|cash_amount|bonus_amount|red_packet_amount|welfare_amount|task_count|popup_interval)$/i;

const emptyArrayKeys = /^(ad_list|ads|ad_data|ad_info|advertisement|splash_ad|launch_ad|open_screen_ad|feed_ad|reward_ad|inspire_ad|commercial_list|promotion_list|popup_list|float_list|pendant_list|welfare_list|benefit_list|task_list|coin_list|bonus_list|red_packet_list|mall_list|game_list|minigame_list|mini_game_list)$/i;

function str(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function objectText(o) {
  if (!o || typeof o !== "object") return "";
  const keys = [
    "title",
    "name",
    "text",
    "label",
    "tab_name",
    "word",
    "desc",
    "description",
    "sub_title",
    "button_text",
    "schema",
    "open_url",
    "url",
    "uri",
    "landing_url",
    "web_url",
    "lynx_url",
    "log_extra",
    "type",
    "card_type",
    "cell_type",
    "component_type",
    "style",
    "tag",
    "business_type",
    "module_name"
  ];

  let out = "";
  for (const k of keys) {
    if (o[k] !== undefined) out += str(o[k]) + " ";
  }
  return out;
}

function isBadObject(o) {
  if (!o || typeof o !== "object") return false;

  const keys = Object.keys(o).join("_");
  const text = objectText(o);

  if (keyBad.test(keys)) return true;
  if (textBad.test(text)) return true;
  if (urlBad.test(text)) return true;

  if (o.is_ad === true) return true;
  if (o.is_ads === true) return true;
  if (o.ad === true) return true;
  if (o.has_ad === true) return true;
  if (o.need_ad === true) return true;
  if (o.show_ad === true) return true;

  if (o.ad_id || o.adid || o.ad_info || o.ad_data || o.ad_extra || o.raw_ad_data) return true;
  if (o.creative_id || o.material_id || o.log_extra) return true;
  if (o.pangolin || o.pangle || o.gromore) return true;

  return false;
}

function clean(v, parentKey = "") {
  if (Array.isArray(v)) {
    return v
      .filter(item => !isBadObject(item))
      .map(item => clean(item, parentKey))
      .filter(item => item !== null && item !== undefined);
  }

  if (!v || typeof v !== "object") return v;

  for (const k of Object.keys(v)) {
    const lower = k.toLowerCase();

    if (emptyArrayKeys.test(k)) {
      v[k] = [];
      continue;
    }

    if (boolFalse.test(k)) {
      v[k] = false;
      continue;
    }

    if (numZero.test(k)) {
      v[k] = 0;
      continue;
    }

    if (keyBad.test(lower)) {
      delete v[k];
      continue;
    }

    if (typeof v[k] === "string") {
      if (textBad.test(v[k]) || urlBad.test(v[k])) {
        delete v[k];
        continue;
      }
    }

    if (Array.isArray(v[k])) {
      v[k] = v[k].filter(item => !isBadObject(item)).map(item => clean(item, k));
      continue;
    }

    if (v[k] && typeof v[k] === "object") {
      if (isBadObject(v[k])) {
        delete v[k];
        continue;
      }
      v[k] = clean(v[k], k);
    }
  }

  return v;
}

function patchKnownLayouts(o) {
  if (!o || typeof o !== "object") return o;

  const listKeys = [
    "tabs",
    "tab_list",
    "bottom_tabs",
    "bottom_tab",
    "bottom_bar",
    "navigation",
    "navigation_list",
    "channel_list",
    "entrance_list",
    "module_list",
    "card_list",
    "cell_list",
    "feed",
    "feeds",
    "feed_list",
    "data_list",
    "aweme_list",
    "video_list",
    "drama_list",
    "book_list",
    "chapter_list",
    "reader_bottom",
    "chapter_end",
    "listen_page",
    "audio_page",
    "float_layer",
    "popup",
    "pendant",
    "operation_list"
  ];

  for (const k of listKeys) {
    if (Array.isArray(o[k])) {
      o[k] = o[k].filter(item => {
        const text = objectText(item);
        return !isBadObject(item) && !textBad.test(text) && !urlBad.test(text);
      });
    }
  }

  return o;
}

function forceDisable(o) {
  if (!o || typeof o !== "object") return o;

  const disableKeys = [
    "show_ad",
    "has_ad",
    "is_ad",
    "need_ad",
    "enable_ad",
    "ad_enabled",
    "show_splash",
    "show_popup",
    "show_float",
    "show_pendant",
    "show_welfare",
    "show_benefit",
    "show_coin",
    "show_task",
    "show_reward",
    "show_inspire",
    "enable_commercial",
    "is_commercial"
  ];

  for (const k of disableKeys) {
    if (k in o) o[k] = false;
  }

  return o;
}

try {
  const ct = ($response.headers && ($response.headers["Content-Type"] || $response.headers["content-type"])) || "";

  if (!/json|text|javascript/i.test(ct) && !/^\s*[\[{]/.test(body)) {
    $done({});
  }

  let obj = JSON.parse(body);

  obj = clean(obj);
  obj = patchKnownLayouts(obj);
  obj = forceDisable(obj);

  $done({ body: JSON.stringify(obj) });
} catch (e) {
  $done({});
}
/**
 * 香港巴士轉乘優惠 Telegram 查詢機器人 (Google Apps Script 版本)
 * 
 * 設定說明：
 * 1. 在 Google 試算表內開啟「擴充功能」->「Apps Script」。
 * 2. 清除所有預設程式碼，將此檔案的所有內容貼上。
 * 3. 前往專案設定 (齒輪圖示)，在「指令碼屬性」(Script Properties) 中新增以下屬性：
 *    - TELEGRAM_BOT_TOKEN: 您的 Telegram Bot API Token (由 @BotFather 取得)
 * 4. 點選部署 -> 新部署 -> 選取類型「網頁應用程式」(Web App)。
 *    - 執行身分：我 (您的帳號)
 *    - 誰有權限存取：任何人 (Anyone)
 * 5. 部署後複製產生的「網頁應用程式 URL」。
 * 6. 在 Apps Script 編輯器中，選擇執行 setTelegramWebhook 函數來註冊 Webhook。
 * 7. 新增一個每週執行的時間驅動觸發程序 (Trigger) 指向 refreshBbiData 函數，以自動更新數據。
 */

// 讀取 Telegram Bot Token
function getBotToken() {
  return PropertiesService.getScriptProperties().getProperty("TELEGRAM_BOT_TOKEN") || "YOUR_TELEGRAM_BOT_TOKEN_HERE";
}

/**
 * 每週更新轉乘優惠數據 (KMB-only, 採用優化的預先分組快取，避免超過儲存格 50,000 字元限制)
 */
function refreshBbiData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("BBI_Cache");
  
  if (!sheet) {
    sheet = ss.insertSheet("BBI_Cache");
  }
  
  sheet.clear();
  sheet.appendRow(["Company", "Route", "Direction", "BbiGroupedJson"]);
  sheet.setFrozenRows(1);
  
  var allRecords = [];
  
  // 1. 抓取 KMB 數據
  try {
    Logger.log("Fetching KMB BBI data...");
    var kmbSuffixes = ["F1", "B1"];
    kmbSuffixes.forEach(function(suffix) {
      var url = "https://www.kmb.hk/storage/BBI_route" + suffix + ".js";
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() == 200) {
        var text = response.getContentText("UTF-8");
        var data = JSON.parse(text);
        
        for (var routeNo in data) {
          var routeData = data[routeNo];
          if (!routeData.Records || !routeData.bus_arr || routeData.bus_arr.length == 0) {
            continue;
          }
          
          var firstDest = routeData.bus_arr[0].dest;
          routeData.Records.forEach(function(rec) {
            var secRoute = (rec.sec_routeno || "").trim();
            var secDest = (rec.sec_dest || "").trim();
            var xchange = (rec.xchange || "").trim();
            
            // 轉換 validity 為時限分鐘
            var validity = rec.validity || "";
            var timeLimit = 150;
            if (validity == "^") timeLimit = 30;
            else if (validity == "#") timeLimit = 60;
            else if (validity == "*") timeLimit = 90;
            else if (validity == "@") timeLimit = 120;
            
            var discount = (rec.discount_max || "").trim();
            var remark = (rec.spec_remark_chi || "").trim();
            
            allRecords.push({
              route: routeNo.trim(),
              direction: firstDest,
              sec_route: secRoute,
              sec_dest: secDest,
              xchange: xchange,
              time_limit: timeLimit,
              discount: discount,
              remark: remark
            });
          });
        }
      }
    });
  } catch (e) {
    Logger.log("Error fetching KMB: " + e.message);
  }
  
  // 2. 在記憶體中進行分組與預先格式化
  Logger.log("Grouping and compressing KMB records...");
  var grouped = {};
  
  allRecords.forEach(function(rec) {
    var rt = rec.route;
    var dir = rec.direction;
    var dirKey = dir.indexOf("往") === 0 ? dir : "往 " + dir;
    var stop = rec.xchange || "任何能接駁第二程路線的巴士站";
    var disc = rec.discount;
    var limit = rec.time_limit;
    var remark = rec.remark || "";
    
    var key = rt + "_" + dirKey;
    if (!grouped[key]) {
      grouped[key] = {
        route: rt,
        direction: dirKey,
        stops: {} // stopName -> discKey -> list of routes
      };
    }
    
    if (!grouped[key].stops[stop]) {
      grouped[key].stops[stop] = {};
    }
    
    var discKey = disc + "_LIMIT_" + limit;
    if (!grouped[key].stops[stop][discKey]) {
      grouped[key].stops[stop][discKey] = {
        disc: disc,
        limit: limit,
        routesList: []
      };
    }
    
    var secInfo = rec.sec_route + " (往 " + rec.sec_dest + ")";
    if (remark) {
      secInfo += " _[" + remark + "]_";
    }
    grouped[key].stops[stop][discKey].routesList.push(secInfo);
  });
  
  // 3. 轉換為扁平化的 JSON 快取結構，確保單個儲存格不會超過 50,000 字元限制
  var rowsToWrite = [];
  for (var key in grouped) {
    var g = grouped[key];
    var cacheArray = [];
    
    for (var stopName in g.stops) {
      var discGroups = [];
      for (var discKey in g.stops[stopName]) {
        var groupDetail = g.stops[stopName][discKey];
        discGroups.push({
          disc: groupDetail.disc,
          limit: groupDetail.limit,
          routes: groupDetail.routesList.join("、")
        });
      }
      cacheArray.push({
        stop: stopName,
        groups: discGroups
      });
    }
    
    rowsToWrite.push([
      "KMB",
      g.route,
      g.direction,
      JSON.stringify(cacheArray)
    ]);
  }
  
  if (rowsToWrite.length > 0) {
    sheet.getRange(2, 1, rowsToWrite.length, 4).setValues(rowsToWrite);
  }
  Logger.log("Successfully wrote " + rowsToWrite.length + " grouped routes to BBI_Cache.");
}

/**
 * 處理來自 Telegram 的 Webhook POST 請求
 */
function doPost(e) {
  try {
    var update = JSON.parse(e.postData.contents);
    
    // 1. 處理 Callback Query (按鈕點擊)
    if (update.callback_query) {
      var callbackId = update.callback_query.id;
      var chatId = update.callback_query.message.chat.id;
      var messageId = update.callback_query.message.message_id;
      var data = update.callback_query.data;
      
      if (data && data.indexOf("bbi:") === 0) {
        var parts = data.split(":");
        var route = parts[1];
        var co = parts[2];
        var dirIndex = parseInt(parts[3], 10);
        
        // 答覆 Telegram Callback (停止載入動畫)
        answerCallbackQuery(callbackId, "正在查詢 " + route + " " + co + "...");
        
        // 獲取該特定方向的 BBI 數據
        var bbiResult = queryBbiDirection(route, co, dirIndex);
        
        // 發送轉乘訊息
        if (bbiResult && bbiResult.messages.length > 0) {
          // 修改原本的按鈕訊息，表示已選擇
          editTelegramMessageText(chatId, messageId, "🚌 路線 <b>" + escapeHtml(route) + "</b> (" + escapeHtml(co) + ")：已選擇 <b>" + escapeHtml(bbiResult.direction) + "</b>");
          
          // 發送 BBI 數據訊息
          bbiResult.messages.forEach(function(msg) {
            sendTelegramMessage(chatId, msg);
          });
        } else {
          sendTelegramMessage(chatId, "❌ 無法取得該方向的轉乘優惠資訊。");
        }
      }
      return HtmlService.createHtmlOutput();
    }
    
    // 2. 處理普通文字訊息
    if (!update.message) return HtmlService.createHtmlOutput();
    
    var chatId = update.message.chat.id;
    var text = (update.message.text || "").trim();
    
    if (text.toLowerCase() === "/start") {
      var welcomeMsg = "🚌 <b>歡迎使用香港巴士轉乘優惠查詢 Bot！</b>\n\n" +
                         "請直接輸入巴士路線編號（例如：<code>968</code>、<code>2A</code>、<code>A11</code>、<code>E21</code>），我會為您查詢相關的轉乘優惠資訊。\n\n" +
                         "本 Bot 支援九巴 (KMB) 快取查詢，以及城巴 (CTB) 即時查詢。";
      sendTelegramMessage(chatId, welcomeMsg);
    } else if (text) {
      var routeQuery = text.toUpperCase();
      handleRouteQuery(chatId, routeQuery);
    }
  } catch (err) {
    console.error("Error in doPost: ", err);
    if (chatId) {
      sendTelegramMessage(chatId, "⚠️ 系統查詢時發生錯誤，請稍後再試。");
    }
  }
  
  return HtmlService.createHtmlOutput();
}

/**
 * 處理巴士路線查詢：獲取所有方向並發送 inline keyboard
 */
function handleRouteQuery(chatId, routeQuery) {
  var directions = getRouteDirections(routeQuery);
  
  if (directions.length === 0) {
    sendTelegramMessage(chatId, "❌ 找不到巴士路線 <b>" + escapeHtml(routeQuery) + "</b> 的轉乘優惠資訊，請檢查輸入是否正確。");
    return;
  }
  
  // 如果只有一個方向，直接發送該方向的 BBI 數據
  if (directions.length === 1) {
    var opt = directions[0];
    var bbiResult = queryBbiDirection(opt.route, opt.company, opt.index);
    if (bbiResult && bbiResult.messages.length > 0) {
      bbiResult.messages.forEach(function(msg) {
        sendTelegramMessage(chatId, msg);
      });
    } else {
      sendTelegramMessage(chatId, "❌ 找不到該路線的轉乘優惠資訊。");
    }
    return;
  }
  
  // 否則，發送 Inline Keyboard 讓用戶選擇方向
  sendInlineKeyboard(chatId, routeQuery, directions);
}

/**
 * 獲取巴士路線的所有方向選項
 */
function getRouteDirections(routeQuery) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss ? ss.getSheetByName("BBI_Cache") : null;
  var directions = [];
  
  // 1. 搜尋九巴快取
  if (sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues(); // Company, Route, Direction
      var kmbDirIndex = 0;
      for (var i = 0; i < data.length; i++) {
        var co = String(data[i][0] || "");
        var rt = String(data[i][1] || "");
        var dir = String(data[i][2] || "");
        
        if (co === "KMB" && rt.toUpperCase() === routeQuery) {
          directions.push({
            company: "KMB",
            route: rt,
            direction: dir,
            index: kmbDirIndex++
          });
        }
      }
    }
  }
  
  // 2. 搜尋城巴即時 API
  var url = "https://www.citybus.com.hk/concessionApi/public/bbi/api/v1/route/tc/" + routeQuery;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() === 200) {
      var text = response.getContentText("UTF-8");
      var data = JSON.parse(text);
      if (data && Object.keys(data).length > 0) {
        var ctbDirIndex = 0;
        for (var groupId in data) {
          var groupData = data[groupId];
          var legType = String(groupData.legType || "1");
          if (legType !== "1") continue;
          
          var dest = (groupData.direction || "").trim();
          var dirKey = dest.indexOf("往") === 0 ? dest : "往 " + dest;
          
          directions.push({
            company: "CTB",
            route: routeQuery,
            direction: dirKey,
            index: ctbDirIndex++
          });
        }
      }
    }
  } catch (e) {
    Logger.log("Error fetching directions from CTB: " + e.message);
  }
  
  return directions;
}

/**
 * 查詢特定公司、路線、方向索引的 BBI 數據，並進行分組與分頁格式化
 */
function queryBbiDirection(routeQuery, company, dirIndex) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss ? ss.getSheetByName("BBI_Cache") : null;
  
  var messages = [];
  var currentMsg = "";
  var limitChar = 3300; // 安全限制
  var selectedDirection = "";
  
  function appendOrPush(blockText, headerText, companyName, routeNo) {
    if (currentMsg === "") {
      currentMsg = headerText + blockText;
    } else if ((currentMsg.length + blockText.length) > limitChar) {
      messages.push(currentMsg.trim());
      currentMsg = "🚌 <b>【" + escapeHtml(companyName) + "】路線 " + escapeHtml(routeNo) + " 轉乘優惠資訊 (續)：</b>\n\n" + blockText;
    } else {
      currentMsg += blockText;
    }
  }
  
  if (company === "KMB" && sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      var kmbCount = 0;
      for (var i = 0; i < data.length; i++) {
        var co = String(data[i][0] || "");
        var rt = String(data[i][1] || "");
        var dir = String(data[i][2] || "");
        var jsonStr = data[i][3] ? String(data[i][3]) : "";
        
        if (co === "KMB" && rt.toUpperCase() === routeQuery) {
          if (kmbCount === dirIndex) {
            selectedDirection = dir;
            var header = "🚌 <b>【KMB】路線 " + escapeHtml(rt) + " 轉乘優惠資訊：</b>\n\n" +
                         "➡ <b>" + escapeHtml(dir) + " 方向：</b>\n";
                         
            var parsedRecords = [];
            if (jsonStr) {
              try {
                parsedRecords = JSON.parse(jsonStr);
              } catch (jsonErr) {
                Logger.log("Error parsing KMB JSON: " + jsonErr.message);
              }
            }
            
            if (parsedRecords.length === 0) {
              var emptyMsg = "  <i>(沒有相關轉乘優惠)</i>\n\n";
              appendOrPush(emptyMsg, header, "KMB", rt);
            } else {
              parsedRecords.forEach(function(item) {
                var stopBlock = " 📍 <b>" + escapeHtml(item.stop) + "</b>\n";
                item.groups.forEach(function(g) {
                  stopBlock += "   • " + escapeHtml(g.disc) + " (時限: " + escapeHtml(g.limit) + "分鐘)\n";
                  var formattedRoutes = escapeHtml(g.routes)
                    .replace(/_\[/g, "<i>[")
                    .replace(/\]_/g, "]</i>");
                  stopBlock += "     👉 " + formattedRoutes + "\n";
                });
                stopBlock += "\n";
                appendOrPush(stopBlock, header, "KMB", rt);
              });
            }
            break;
          }
          kmbCount++;
        }
      }
    }
  } else if (company === "CTB") {
    // 查詢城巴即時 API
    var url = "https://www.citybus.com.hk/concessionApi/public/bbi/api/v1/route/tc/" + routeQuery;
    try {
      var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() === 200) {
        var text = response.getContentText("UTF-8");
        var data = JSON.parse(text);
        if (data && Object.keys(data).length > 0) {
          var ctbCount = 0;
          for (var groupId in data) {
            var groupData = data[groupId];
            var legType = String(groupData.legType || "1");
            if (legType !== "1") continue;
            
            if (ctbCount === dirIndex) {
              var dest = (groupData.direction || "").trim();
              var dirKey = dest.indexOf("往") === 0 ? dest : "往 " + dest;
              selectedDirection = dirKey;
              
              var header = "🚌 <b>【CTB】路線 " + escapeHtml(routeQuery) + " 轉乘優惠資訊：</b>\n\n" +
                           "➡ <b>" + escapeHtml(dirKey) + " 方向：</b>\n";
              
              var groupedStops = {};
              var irList = groupData.ir || [];
              irList.forEach(function(rec) {
                var secRoute = (rec.route || "").trim();
                var secDest = (rec.direction || "").trim();
                var xchange = (rec.stopName || "").trim();
                
                var timeLimit = 120;
                try {
                  timeLimit = parseInt(rec.timeLimit || "120", 10);
                } catch(e) {}
                
                var discountCode = rec.discount || "";
                var totalFareObj = rec.totalFare || {};
                var discountAmountObj = rec.discountAmount || {};
                
                var discount = "免費 / 補差價";
                if (totalFareObj && totalFareObj.adult !== undefined && totalFareObj.adult !== null && totalFareObj.adult !== "") {
                  discount = "兩程合共 $" + totalFareObj.adult;
                } else if (discountAmountObj && discountAmountObj.adult !== undefined && discountAmountObj.adult !== null && discountAmountObj.adult !== "") {
                  var val = discountAmountObj.adult;
                  if (val === "0" || val === 0) {
                    discount = "免費";
                  } else {
                    discount = "減 $" + val;
                  }
                } else {
                  if (discountCode == "L2") {
                    discount = "免費 (補差價 / 祇收較高票價)";
                  } else if (discountCode == "FR") {
                    discount = "免費";
                  } else if (discountCode == "L1") {
                    discount = "免費 (祇收較高票價)";
                  }
                }
                
                var remark = (rec.remark || "").trim();
                
                if (!groupedStops[xchange]) {
                  groupedStops[xchange] = {};
                }
                
                var discKey = discount + "_LIMIT_" + timeLimit;
                if (!groupedStops[xchange][discKey]) {
                  groupedStops[xchange][discKey] = {
                    disc: discount,
                    limit: timeLimit,
                    routesList: []
                  };
                }
                
                var secInfo = "<code>" + escapeHtml(secRoute) + "</code> (往 " + escapeHtml(secDest) + ")";
                if (remark) {
                  secInfo += " <i>[" + escapeHtml(remark) + "]</i>";
                }
                groupedStops[xchange][discKey].routesList.push(secInfo);
              });
              
              // 轉成 stop 單位格式化
              for (var stopName in groupedStops) {
                var stopBlock = " 📍 <b>" + escapeHtml(stopName) + "</b>\n";
                for (var discKey in groupedStops[stopName]) {
                  var g = groupedStops[stopName][discKey];
                  stopBlock += "   • " + escapeHtml(g.disc) + " (時限: " + escapeHtml(g.limit) + "分鐘)\n";
                  stopBlock += "     👉 " + g.routesList.join("、") + "\n";
                }
                stopBlock += "\n";
                appendOrPush(stopBlock, header, "CTB", routeQuery);
              }
              break;
            }
            ctbCount++;
          }
        }
      }
    } catch (e) {
      Logger.log("Error querying CTB direction: " + e.message);
    }
  }
  
  if (currentMsg.trim() !== "") {
    currentMsg += "════════════════════\n\n";
    messages.push(currentMsg.trim());
  }
  
  return {
    direction: selectedDirection,
    messages: messages
  };
}

/**
 * 發送 Inline Keyboard 選擇方向
 */
function sendInlineKeyboard(chatId, routeQuery, directions) {
  var token = getBotToken();
  var url = "https://api.telegram.org/bot" + token + "/sendMessage";
  
  var keyboard = [];
  directions.forEach(function(opt) {
    var buttonText = "【" + opt.company + "】" + opt.direction;
    var callbackData = "bbi:" + opt.route + ":" + opt.company + ":" + opt.index;
    
    keyboard.push([{
      "text": buttonText,
      "callback_data": callbackData
    }]);
  });
  
  var payload = {
    "chat_id": chatId,
    "text": "🚌 請選擇路線 <b>" + escapeHtml(routeQuery) + "</b> 的方向：",
    "parse_mode": "HTML",
    "reply_markup": JSON.stringify({
      "inline_keyboard": keyboard
    })
  };
  
  var options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  Logger.log("Send keyboard response: " + response.getContentText());
}

/**
 * 答覆 Telegram Callback Query (消除按鈕載入動畫)
 */
function answerCallbackQuery(callbackId, text) {
  var token = getBotToken();
  var url = "https://api.telegram.org/bot" + token + "/answerCallbackQuery";
  
  var payload = {
    "callback_query_id": callbackId,
    "text": text
  };
  
  var options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  UrlFetchApp.fetch(url, options);
}

/**
 * 編輯已存在的 Telegram 訊息內文 (並移除按鈕)
 */
function editTelegramMessageText(chatId, messageId, text) {
  var token = getBotToken();
  var url = "https://api.telegram.org/bot" + token + "/editMessageText";
  
  var payload = {
    "chat_id": chatId,
    "message_id": messageId,
    "text": text,
    "parse_mode": "HTML"
  };
  
  var options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  Logger.log("Edit message response: " + response.getContentText());
}

/**
 * 發送 Telegram 訊息 (HTML 格式)
 */
function sendTelegramMessage(chatId, text) {
  var token = getBotToken();
  var url = "https://api.telegram.org/bot" + token + "/sendMessage";
  
  // 安全限制：避免 Telegram 4096 限制
  if (text.length > 4000) {
    text = text.substring(0, 3970) + "...";
  }
  
  var payload = {
    "chat_id": chatId,
    "text": text,
    "parse_mode": "HTML"
  };
  
  var options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  Logger.log("Send message response: " + response.getContentText());
}

/**
 * 註冊 Telegram Webhook (在 GAS 部署新網頁應用程式後手動點選執行一次)
 */
function setTelegramWebhook() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var webAppUrl = ""; // 請貼上您部署網頁應用程式後取得的 URL
  
  if (!webAppUrl) {
    webAppUrl = ScriptApp.getService().getUrl();
  }
  
  if (!webAppUrl || webAppUrl.indexOf("exec") === -1) {
    Logger.log("⚠️ 請在程式碼中手動填入部署後產生的『網頁應用程式 URL』再執行此函數。");
    return;
  }
  
  var token = getBotToken();
  var url = "https://api.telegram.org/bot" + token + "/setWebhook?url=" + encodeURIComponent(webAppUrl);
  
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log("Webhook 註冊結果: " + response.getContentText());
}

/**
 * HTML 字元逸出 (避免 HTML 標籤解析錯誤)
 */
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

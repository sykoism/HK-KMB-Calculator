import urllib.request
import json
import ssl
import re
import sys

# Disable SSL verification for convenience (needed on some networks/sandboxes)
ssl._create_default_https_context = ssl._create_unverified_context

def fetch_kmb_bbi():
    print("Fetching KMB BBI data...")
    headers = {'User-Agent': 'Mozilla/5.0'}
    
    records = []
    for suffix in ['F1', 'B1']:
        url = f"https://www.kmb.hk/storage/BBI_route{suffix}.js"
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode('utf-8'))
                for route_no, route_data in data.items():
                    if "Records" not in route_data or not route_data["bus_arr"]:
                        continue
                    
                    first_dest = route_data["bus_arr"][0]["dest"]
                    
                    for rec in route_data["Records"]:
                        sec_route = rec.get("sec_routeno", "").strip()
                        sec_dest = rec.get("sec_dest", "").strip()
                        xchange = rec.get("xchange", "").strip()
                        
                        # Resolve validity to time limit in minutes
                        validity = rec.get("validity", "")
                        time_limit = 150
                        if validity == "^":
                            time_limit = 30
                        elif validity == "#":
                            time_limit = 60
                        elif validity == "*":
                            time_limit = 90
                        elif validity == "@":
                            time_limit = 120
                        
                        discount = rec.get("discount_max", "").strip()
                        remark = rec.get("spec_remark_chi", "").strip()
                        
                        records.append({
                            "company": "KMB",
                            "route": route_no.strip(),
                            "direction": first_dest,
                            "sec_route": sec_route,
                            "sec_dest": sec_dest,
                            "xchange": xchange,
                            "time_limit": time_limit,
                            "discount": discount,
                            "remark": remark
                        })
        except Exception as e:
            print(f"Error fetching KMB BBI {suffix}: {e}")
            
    print(f"Fetched {len(records)} KMB BBI records.")
    return records

def fetch_ctb_bbi():
    # Deprecated crawling schemes 2-94, we now query Citybus BBI live on-demand.
    return []

def query_ctb_bbi_live(route_no):
    headers = {'User-Agent': 'Mozilla/5.0'}
    url = f"https://www.citybus.com.hk/concessionApi/public/bbi/api/v1/route/tc/{route_no}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))
            if not data:
                return None
            
            # Group records for first leg (legType == 1 or "1")
            grouped = {}
            for group_id, group_data in data.items():
                leg_type = str(group_data.get("legType", "1"))
                if leg_type != "1":
                    continue
                
                dest = group_data.get("direction", "").strip()
                dir_key = f"往 {dest}" if not dest.startswith("往") else dest
                
                if dir_key not in grouped:
                    grouped[dir_key] = {}
                
                for rec in group_data.get("ir", []):
                    sec_route = rec.get("route", "").strip()
                    sec_dest = rec.get("direction", "").strip()
                    xchange = rec.get("stopName", "").strip() or "任何能接駁第二程路線的巴士站"
                    
                    time_limit = 120
                    try:
                        time_limit = int(rec.get("timeLimit", "120"))
                    except:
                        pass
                    
                    # Parse CTB discount
                    discount_code = rec.get("discount", "")
                    total_fare_obj = rec.get("totalFare", {}) or {}
                    discount_amount_obj = rec.get("discountAmount", {}) or {}
                    
                    discount = "免費 / 補差價"
                    if total_fare_obj.get("adult") is not None:
                        discount = f"兩程合共 ${total_fare_obj['adult']}"
                    elif discount_amount_obj.get("adult") is not None:
                        val = discount_amount_obj["adult"]
                        if val == "0" or val == 0:
                            discount = "免費"
                        else:
                            discount = f"減 ${val}"
                    else:
                        if discount_code == "L2":
                            discount = "免費 (補差價 / 祇收較高票價)"
                        elif discount_code == "FR":
                            discount = "免費"
                        elif discount_code == "L1":
                            discount = "免費 (祇收較高票價)"
                    
                    remark = rec.get("remark", "").strip()
                    
                    if xchange not in grouped[dir_key]:
                        grouped[dir_key][xchange] = {}
                        
                    disc_key = (discount, time_limit)
                    if disc_key not in grouped[dir_key][xchange]:
                        grouped[dir_key][xchange][disc_key] = []
                        
                    sec_info = f"{sec_route} (往 {sec_dest})"
                    if remark:
                        sec_info += f" [{remark}]"
                    grouped[dir_key][xchange][disc_key].append(sec_info)
            
            # Now flatten the CTB live structure to match the pre-grouped list format
            flat_grouped = {}
            for dir_key, stops_data in grouped.items():
                stops_list = []
                for stop_name, discs in stops_data.items():
                    groups_list = []
                    for (disc, limit), routes_list in discs.items():
                        groups_list.append({
                            "disc": disc,
                            "limit": limit,
                            "routes": "、".join(routes_list)
                        })
                    stops_list.append({
                        "stop": stop_name,
                        "groups": groups_list
                    })
                flat_grouped[dir_key] = stops_list
                
            if not flat_grouped:
                return None
            return flat_grouped
    except Exception as e:
        return None

def group_bbi_records(records):
    """
    Groups BBI records by: Company -> Route -> Direction -> List of {stop, groups: [{disc, limit, routes}]}
    """
    grouped = {}
    for rec in records:
        co = rec["company"]
        rt = rec["route"]
        dir_name = rec["direction"]
        dir_key = f"往 {dir_name}" if not dir_name.startswith("往") else dir_name
        stop = rec["xchange"] or "任何能接駁第二程路線的巴士站"
        disc = rec["discount"]
        limit = rec["time_limit"]
        
        key = (co, rt, dir_key)
        if key not in grouped:
            grouped[key] = {}
        if stop not in grouped[key]:
            grouped[key][stop] = {}
            
        disc_key = (disc, limit)
        if disc_key not in grouped[key][stop]:
            grouped[key][disc_key] = []
            
        sec_info = f"{rec['sec_route']} (往 {rec['sec_dest']})"
        if rec["remark"]:
            sec_info += f" [{rec['remark']}]"
        grouped[key][stop][disc_key].append(sec_info)
        
    db = {}
    for (co, rt, dir_key), stops_data in grouped.items():
        if co not in db:
            db[co] = {}
        if rt not in db[co]:
            db[co][rt] = {}
            
        stops_list = []
        for stop_name, discs in stops_data.items():
            groups_list = []
            for (disc, limit), routes_list in discs.items():
                groups_list.append({
                    "disc": disc,
                    "limit": limit,
                    "routes": "、".join(routes_list)
                })
            stops_list.append({
                "stop": stop_name,
                "groups": groups_list
            })
            
        db[co][rt][dir_key] = stops_list
        
    return db

def format_bbi_message(route_no, co, directions_data):
    """
    Generates a Traditional Chinese message for a route's BBI options (flat pre-grouped format)
    """
    msg = f"🚌 【{co}】巴士路線 {route_no} 轉乘優惠資訊：\n\n"
    
    for dir_name, stops_list in directions_data.items():
        msg += f"➡ {dir_name} 方向：\n"
        
        if not stops_list:
            msg += "  (無可用轉乘優惠)\n\n"
            continue
            
        for item in stops_list:
            msg += f" 📍 {item['stop']}\n"
            for g in item["groups"]:
                msg += f"   • {g['disc']} (時限: {g['limit']}分鐘)\n"
                msg += f"     👉 轉乘路線: {g['routes']}\n"
            msg += "\n"
        msg += "════════════════════\n\n"
        
    return msg.strip()

def query_route(route_no, db):
    route_no = route_no.strip().upper()
    found = False
    
    # 1. Query KMB (from local DB)
    if "KMB" in db and route_no in db["KMB"]:
        found = True
        directions_data = db["KMB"][route_no]
        msg = format_bbi_message(route_no, "KMB", directions_data)
        print(msg)
        print("-" * 40)
        
    # 2. Query CTB (Live API)
    ctb_data = query_ctb_bbi_live(route_no)
    if ctb_data:
        found = True
        msg = format_bbi_message(route_no, "CTB", ctb_data)
        print(msg)
        print("-" * 40)
            
    if not found:
        print(f"❌ 找不到路線 {route_no} 的轉乘優惠資訊。")

if __name__ == "__main__":
    print("=== HK Bus BBI Crawler Local Test ===")
    
    kmb_recs = fetch_kmb_bbi()
    ctb_recs = fetch_ctb_bbi()
    
    all_records = kmb_recs + ctb_recs
    db = group_bbi_records(all_records)
    
    print("\n=== Data Crawl Complete! ===")
    print("Available KMB Routes count:", len(db.get("KMB", {})))
    print("Available CTB Routes count:", len(db.get("CTB", {})))
    print("===========================\n")
    
    # Enter interactive loop
    while True:
        try:
            q = input("請輸入巴士路線進行查詢 (輸入 exit 退出): ").strip()
            if not q or q.lower() == 'exit':
                break
            query_route(q, db)
        except KeyboardInterrupt:
            break
        except Exception as e:
            print("查詢出錯:", e)

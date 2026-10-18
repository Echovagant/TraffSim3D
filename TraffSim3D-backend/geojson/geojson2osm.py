#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import xml.etree.ElementTree as ET
from xml.dom import minidom

# 读取 GeoJSON 文件
with open("roads.geojson", "r", encoding="utf-8") as f:
    geojson = json.load(f)

osm = ET.Element("osm", version="0.6", generator="geojson2osm")

# 用于存储节点，避免重复
node_cache = {}
# 节点 ID 使用负值（临时 ID）
node_id_counter = -1


def get_node_id(lon, lat):
    """根据坐标返回节点 ID，缓存复用"""
    global node_id_counter
    key = (round(lon, 7), round(lat, 7))  # 保留7位小数避免浮点误差
    if key not in node_cache:
        node_id_counter -= 1
        node = ET.SubElement(osm, "node", id=str(node_id_counter), lat=str(lat), lon=str(lon))
        node_cache[key] = node_id_counter
    return node_cache[key]


# 处理每个 Feature
for feature in geojson["features"]:
    geom = feature["geometry"]
    props = feature["properties"]
    # 获取原始 way id
    osm_id = props.get("@id", "").replace("way/", "")
    if not osm_id.isdigit():
        # 如果没有合法 id，使用一个递增的负 id
        osm_id = str(node_id_counter)  # 临时处理，但最好避免
        node_id_counter -= 1

    geom_type = geom["type"]
    coords = geom["coordinates"]

    way = ET.SubElement(osm, "way", id=str(osm_id), visible="true")

    # 处理 Polygon / LineString
    if geom_type == "Polygon":
        # 取外环（第一个数组）
        ring = coords[0]
        for lon, lat in ring:
            nd = ET.SubElement(way, "nd", ref=str(get_node_id(lon, lat)))
        # 注意：GeoJSON 第一个点和最后一个点相同，已经是闭合的
    elif geom_type == "LineString":
        for lon, lat in coords:
            nd = ET.SubElement(way, "nd", ref=str(get_node_id(lon, lat)))
    else:
        # 其他类型（如 MultiPolygon）这里没有，可跳过
        continue

    # 添加所有属性作为标签（跳过 @id）
    for k, v in props.items():
        if k == "@id":
            continue
        # 确保值是字符串
        if isinstance(v, bool):
            v = "yes" if v else "no"
        elif v is None:
            continue
        ET.SubElement(way, "tag", k=k, v=str(v))

# 生成格式化 XML
xml_str = ET.tostring(osm, encoding="unicode")
dom = minidom.parseString(xml_str)
pretty_xml = dom.toprettyxml(indent="  ")

# 写入文件
with open("roads.osm", "w", encoding="utf-8") as f:
    f.write(pretty_xml)

print("转换完成，已生成 roads.osm")

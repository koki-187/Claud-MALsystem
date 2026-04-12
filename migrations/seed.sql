-- MAL Search System - Seed Data
-- Version: 5.0.0
-- 15 realistic Japanese property records across different prefectures and sites

INSERT OR IGNORE INTO properties (
  id, site_id, site_property_id, title, property_type, prefecture, city, address,
  price, price_text, area, building_area, land_area, rooms, age, floor, total_floors,
  station, station_minutes, thumbnail_url, detail_url, description, latitude, longitude,
  created_at, updated_at, scraped_at
) VALUES

-- 東京都 - SUUMO
(
  'suumo_seed_001', 'suumo', 'seed_001',
  '港区赤坂タワーマンション 3LDK 85.5m²',
  'mansion', '13', '港区', '東京都港区赤坂2丁目',
  18500, '1億8,500万円',
  85.5, 85.5, NULL, '3LDK', 3, 22, 35,
  '赤坂見附', 5, NULL,
  'https://suumo.jp/ms/mansion/tokyo/sc_minato/001/',
  '港区赤坂の高層タワーマンション。眺望良好、24時間コンシェルジュ付き。',
  35.6762, 139.7360,
  datetime('now'), datetime('now'), datetime('now')
),

-- 東京都 - HOMES
(
  'homes_seed_001', 'homes', 'seed_001',
  '新宿区西新宿マンション 2LDK リノベーション済',
  'mansion', '13', '新宿区', '東京都新宿区西新宿7丁目',
  7800, '7,800万円',
  62.3, 62.3, NULL, '2LDK', 12, 8, 15,
  '新宿', 8, NULL,
  'https://www.homes.co.jp/mansion/buy/b-001/',
  '新宿区の便利な立地。フルリノベーション済みで入居後すぐに快適な生活が可能。',
  35.6907, 139.6926,
  datetime('now'), datetime('now'), datetime('now')
),

-- 大阪府 - AtHome
(
  'athome_seed_001', 'athome', 'seed_001',
  '大阪市北区梅田マンション 1LDK 45.8m²',
  'mansion', '27', '大阪市北区', '大阪府大阪市北区梅田1丁目',
  4200, '4,200万円',
  45.8, 45.8, NULL, '1LDK', 5, 18, 42,
  '梅田', 3, NULL,
  'https://www.athome.co.jp/mansion/001/',
  '梅田駅徒歩3分の好立地。投資用・居住用どちらにも最適。',
  34.7025, 135.4959,
  datetime('now'), datetime('now'), datetime('now')
),

-- 神奈川県 - 不動産Japan
(
  'fudosan_seed_001', 'fudosan', 'seed_001',
  '横浜市中区みなとみらい マンション 3LDK 90.2m²',
  'mansion', '14', '横浜市中区', '神奈川県横浜市中区みなとみらい3丁目',
  9800, '9,800万円',
  90.2, 90.2, NULL, '3LDK', 8, 25, 38,
  'みなとみらい', 6, NULL,
  'https://fudosan.jp/mansion/001/',
  'みなとみらいの眺望抜群マンション。横浜の夜景を毎日楽しめる贅沢な物件。',
  35.4561, 139.6380,
  datetime('now'), datetime('now'), datetime('now')
),

-- 愛知県 - CHINTAI
(
  'chintai_seed_001', 'chintai', 'seed_001',
  '名古屋市中区栄 賃貸マンション 2LDK',
  'chintai_mansion', '23', '名古屋市中区', '愛知県名古屋市中区栄4丁目',
  18, '家賃18万円',
  65.4, 65.4, NULL, '2LDK', 6, 10, 20,
  '栄', 5, NULL,
  'https://chintai.net/rent/001/',
  '栄駅すぐの賃貸マンション。名古屋のビジネス中心地へのアクセス抜群。',
  35.1688, 136.9072,
  datetime('now'), datetime('now'), datetime('now')
),

-- 福岡県 - Smaity
(
  'smaity_seed_001', 'smaity', 'seed_001',
  '福岡市中央区天神マンション 2LDK 投資用',
  'mansion', '40', '福岡市中央区', '福岡県福岡市中央区天神2丁目',
  3500, '3,500万円',
  52.1, 52.1, NULL, '2LDK', 10, 7, 14,
  '天神', 4, NULL,
  'https://smaity.com/mansion/001/',
  '福岡の中心地天神に位置する投資用マンション。高い賃貸需要が見込める。',
  33.5904, 130.3976,
  datetime('now'), datetime('now'), datetime('now')
),

-- 北海道 - REINS
(
  'reins_seed_001', 'reins', 'seed_001',
  '札幌市中央区円山西町 一戸建て 4LDK',
  'kodate', '01', '札幌市中央区', '北海道札幌市中央区円山西町3丁目',
  4800, '4,800万円',
  120.5, 120.5, 180.0, '4LDK', 15, NULL, NULL,
  '円山公園', 10, NULL,
  'https://www.reins.or.jp/property/001/',
  '円山公園近くの閑静な住宅地に位置する4LDKの一戸建て。広い庭付き。',
  43.0517, 141.3219,
  datetime('now'), datetime('now'), datetime('now')
),

-- 東京都 - SUUMO (賃貸)
(
  'suumo_seed_002', 'suumo', 'seed_002',
  '渋谷区代官山 賃貸1LDK デザイナーズ',
  'chintai_mansion', '13', '渋谷区', '東京都渋谷区代官山町',
  22, '家賃22万円',
  48.6, 48.6, NULL, '1LDK', 4, 3, 5,
  '代官山', 3, NULL,
  'https://suumo.jp/chintai/tokyo/sc_shibuya/002/',
  '代官山のデザイナーズマンション。おしゃれな内装で女性に大人気の物件。',
  35.6484, 139.7034,
  datetime('now'), datetime('now'), datetime('now')
),

-- 埼玉県 - HOMES
(
  'homes_seed_002', 'homes', 'seed_002',
  'さいたま市大宮区 一戸建て 4LDK 新築',
  'kodate', '11', 'さいたま市大宮区', '埼玉県さいたま市大宮区天沼町',
  5200, '5,200万円',
  105.3, 105.3, 132.5, '4LDK', 0, NULL, NULL,
  '大宮', 15, NULL,
  'https://www.homes.co.jp/kodate/b-002/',
  '大宮駅徒歩15分の新築一戸建て。広々とした間取りとモダンな外観が特徴。',
  35.9079, 139.6197,
  datetime('now'), datetime('now'), datetime('now')
),

-- 京都府 - AtHome
(
  'athome_seed_002', 'athome', 'seed_002',
  '京都市中京区 京町家リノベーション物件',
  'kodate', '26', '京都市中京区', '京都府京都市中京区麩屋町通三条',
  6800, '6,800万円',
  95.2, 95.2, 68.5, '4LDK', 80, NULL, NULL,
  '烏丸御池', 8, NULL,
  'https://www.athome.co.jp/kodate/002/',
  '築80年の京町家をフルリノベーション。伝統的な意匠を活かしながら現代の快適さを実現。',
  35.0116, 135.7681,
  datetime('now'), datetime('now'), datetime('now')
),

-- 千葉県 - 不動産Japan
(
  'fudosan_seed_002', 'fudosan', 'seed_002',
  '千葉市花見川区 土地 220m² 建築条件なし',
  'tochi', '12', '千葉市花見川区', '千葉県千葉市花見川区幕張本郷',
  2800, '2,800万円',
  NULL, NULL, 220.0, NULL, NULL, NULL, NULL,
  '幕張本郷', 12, NULL,
  'https://fudosan.jp/tochi/002/',
  '建築条件なしの広大な土地。周辺環境が良く、理想の住宅を建築可能。',
  35.6503, 140.0576,
  datetime('now'), datetime('now'), datetime('now')
),

-- 兵庫県 - CHINTAI
(
  'chintai_seed_002', 'chintai', 'seed_002',
  '神戸市中央区三宮 賃貸マンション 1K',
  'chintai_mansion', '28', '神戸市中央区', '兵庫県神戸市中央区磯上通',
  7, '家賃7万円',
  28.5, 28.5, NULL, '1K', 8, 5, 12,
  '三宮', 7, NULL,
  'https://chintai.net/rent/002/',
  '三宮駅徒歩7分の1Kマンション。神戸の中心部で一人暮らしに最適。',
  34.6913, 135.1996,
  datetime('now'), datetime('now'), datetime('now')
),

-- 宮城県 - Smaity
(
  'smaity_seed_002', 'smaity', 'seed_002',
  '仙台市青葉区一番町 事務所・店舗物件',
  'jimusho', '04', '仙台市青葉区', '宮城県仙台市青葉区一番町2丁目',
  8500, '8,500万円',
  145.8, 145.8, NULL, NULL, 20, 3, 8,
  '仙台', 10, NULL,
  'https://smaity.com/jimusho/001/',
  '仙台市中心部の事務所・店舗物件。高い視認性と集客力を誇るビジネス立地。',
  38.2682, 140.8694,
  datetime('now'), datetime('now'), datetime('now')
),

-- 沖縄県 - REINS
(
  'reins_seed_002', 'reins', 'seed_002',
  '那覇市国際通り近く マンション 2LDK オーシャンビュー',
  'mansion', '47', '那覇市', '沖縄県那覇市牧志2丁目',
  3200, '3,200万円',
  68.9, 68.9, NULL, '2LDK', 12, 8, 15,
  '牧志', 10, NULL,
  'https://www.reins.or.jp/property/002/',
  '国際通り徒歩圏内のマンション。晴れた日には海が見える眺望良好な物件。',
  26.2124, 127.6809,
  datetime('now'), datetime('now'), datetime('now')
),

-- 広島県 - SUUMO
(
  'suumo_seed_003', 'suumo', 'seed_003',
  '広島市中区紙屋町 新築マンション 3LDK',
  'mansion', '34', '広島市中区', '広島県広島市中区紙屋町1丁目',
  4500, '4,500万円',
  78.4, 78.4, NULL, '3LDK', 0, 12, 25,
  '本通', 5, NULL,
  'https://suumo.jp/ms/mansion/hiroshima/sc_hiroshimachi/003/',
  '広島市中心部の新築タワーマンション。最新設備完備、子育て支援施設も充実。',
  34.3966, 132.4596,
  datetime('now'), datetime('now'), datetime('now')
);

-- Insert features for seed properties
INSERT OR IGNORE INTO property_features (property_id, feature) VALUES
('suumo_seed_001', 'オートロック'),
('suumo_seed_001', '24時間コンシェルジュ'),
('suumo_seed_001', '宅配ボックス'),
('suumo_seed_001', 'フィットネスジム'),
('suumo_seed_001', 'ゲストルーム'),
('homes_seed_001', 'フルリノベーション'),
('homes_seed_001', 'システムキッチン'),
('homes_seed_001', '床暖房'),
('athome_seed_001', '眺望良好'),
('athome_seed_001', '角部屋'),
('fudosan_seed_001', 'オーシャンビュー'),
('fudosan_seed_001', 'タワーマンション'),
('chintai_seed_001', '駅近'),
('chintai_seed_001', 'ペット可'),
('smaity_seed_001', '投資用'),
('smaity_seed_001', '高利回り'),
('reins_seed_001', '庭付き'),
('reins_seed_001', 'ガレージ'),
('suumo_seed_002', 'デザイナーズ'),
('suumo_seed_002', 'インターネット無料'),
('homes_seed_002', '新築'),
('homes_seed_002', '床暖房'),
('athome_seed_002', '京町家'),
('athome_seed_002', '歴史的建造物'),
('chintai_seed_002', '都市ガス'),
('smaity_seed_002', '路面店舗'),
('reins_seed_002', '海望'),
('suumo_seed_003', '新築'),
('suumo_seed_003', '子育て支援'),
('suumo_seed_003', '免震構造');

-- Insert price history for some properties
INSERT OR IGNORE INTO price_history (property_id, price, recorded_at) VALUES
('suumo_seed_001', 18000, datetime('now', '-6 months')),
('suumo_seed_001', 18200, datetime('now', '-3 months')),
('suumo_seed_001', 18500, datetime('now')),
('homes_seed_001', 8200, datetime('now', '-12 months')),
('homes_seed_001', 8000, datetime('now', '-6 months')),
('homes_seed_001', 7800, datetime('now')),
('fudosan_seed_001', 9500, datetime('now', '-6 months')),
('fudosan_seed_001', 9800, datetime('now'));

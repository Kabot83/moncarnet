/**
 * Dictionnaire des ingrédients courants : nom usuel → aliment CIQUAL 2025, et poids usuels.
 *
 * Correspondances : codes de la table CIQUAL 2025 (ANSES), vérifiés par les tests
 * (tests/unit/autonutrition.test.ts). Le choix d'une variante « courante » (farine T55,
 * lait demi-écrémé, beurre doux…) est une hypothèse : il est présenté comme une
 * correspondance automatique, que l'utilisateur peut corriger.
 *
 * Poids usuels (TOUJOURS des estimations, affichées comme telles) :
 *   - 'usda'  : portions de référence de l'USDA FoodData Central (SR Legacy), domaine public
 *               — ex. oignon moyen 110 g, œuf (gros) 50 g sans coquille, banane moyenne 118 g ;
 *   - 'usage' : contenance standard des emballages en France (sachet de levure chimique 11 g,
 *               feuille de gélatine 2 g, cube de bouillon 10 g, pot de yaourt 125 g, boîte 400 g…) ;
 *   - 'estimate' : ordre de grandeur retenu par Mon Carnet faute de référence publiée.
 * Masses volumiques (g/ml) : déduites des poids USDA par cuillère ou par tasse
 * (ex. huile 13,5 g / 14,8 ml ≈ 0,91 ; farine 7,8 g / 14,8 ml ≈ 0,53).
 */

export type WeightSource = 'usda' | 'usage' | 'estimate'
export interface UsualWeight {
  grams: number
  source: WeightSource
}

export interface DictionaryEntry {
  /** Libellé affiché (« oignon »). */
  label: string
  /**
   * Noms reconnus (normalisés à l'usage). Le plus long qui correspond l'emporte.
   * Préfixe « ~ » : nom générique pour lequel une variante courante est SUPPOSÉE (« lait » →
   * demi-écrémé) ; le résultat est alors signalé comme estimatif.
   */
  names: string[]
  /** Code CIQUAL de l'aliment cru / tel quel. */
  ciqual: string
  /** Mots supplémentaires admis sans changer l'aliment (« blé », « tendre »…). */
  allow?: string[]
  /** Poids d'une pièce moyenne (partie comestible). */
  piece?: UsualWeight
  /** Poids pour une unité de recette (gousse, sachet, feuille, tranche, pot, cube…). */
  units?: Record<string, UsualWeight>
  /** Masse volumique usuelle (g/ml), pour les cuillères et volumes. */
  density?: UsualWeight
  /** Assaisonnement : sans quantité indiquée, apport négligeable (non compté, sans rendre le total partiel). */
  seasoning?: boolean
}

const U = (grams: number): UsualWeight => ({ grams, source: 'usda' })
const S = (grams: number): UsualWeight => ({ grams, source: 'usage' })
const E = (grams: number): UsualWeight => ({ grams, source: 'estimate' })

export const DICTIONARY: DictionaryEntry[] = [
  // --- Œufs ------------------------------------------------------------------
  { label: 'œuf', names: ['oeuf', 'oeuf entier', 'oeuf poule'], ciqual: '22000', piece: U(50) },
  { label: 'jaune d’œuf', names: ['jaune oeuf', 'jaune'], ciqual: '22002', piece: U(17) },
  { label: 'blanc d’œuf', names: ['blanc oeuf'], ciqual: '22001', piece: U(33) },

  // --- Légumes ---------------------------------------------------------------
  { label: 'oignon', names: ['oignon', 'oignon jaune', 'oignon blanc'], ciqual: '20034', piece: U(110) },
  { label: 'oignon rouge', names: ['oignon rouge'], ciqual: '20238', piece: U(110) },
  { label: 'échalote', names: ['echalote'], ciqual: '20097', piece: S(30) },
  { label: 'ail', names: ['ail', 'gousse ail'], ciqual: '11000', units: { gousse: U(3) }, piece: U(3), seasoning: true },
  { label: 'carotte', names: ['carotte'], ciqual: '20009', piece: U(61) },
  { label: 'pomme de terre', names: ['pomme terre', 'patate'], ciqual: '4008', piece: U(213) },
  { label: 'patate douce', names: ['patate douce'], ciqual: '4101', piece: U(130) },
  { label: 'tomate', names: ['tomate'], ciqual: '20276', piece: U(123) },
  { label: 'tomate cerise', names: ['tomate cerise'], ciqual: '20172', piece: U(17) },
  { label: 'courgette', names: ['courgette'], ciqual: '20020', piece: U(196) },
  { label: 'aubergine', names: ['aubergine'], ciqual: '20053', piece: U(548) },
  { label: 'poivron', names: ['poivron', 'poivron rouge'], ciqual: '20087', piece: U(119) },
  { label: 'concombre', names: ['concombre'], ciqual: '20019', piece: U(301) },
  { label: 'poireau', names: ['poireau'], ciqual: '20039', piece: U(89) },
  { label: 'céleri', names: ['celeri', 'celeri branche', 'branche celeri'], ciqual: '20023', piece: U(40) },
  { label: 'champignon', names: ['champignon', 'champignon paris'], ciqual: '20056', piece: U(18) },
  { label: 'épinard', names: ['epinard', 'pousse epinard'], ciqual: '20059' },
  { label: 'haricot vert', names: ['haricot vert'], ciqual: '20061' },
  { label: 'petits pois', names: ['petit poi', 'petits poi'], ciqual: '20072' },
  { label: 'brocoli', names: ['brocoli'], ciqual: '20057' },
  { label: 'chou-fleur', names: ['chou fleur'], ciqual: '20016', piece: U(588) },
  { label: 'potiron', names: ['potiron', 'citrouille'], ciqual: '20044' },
  { label: 'courge butternut', names: ['butternut', 'courge butternut', 'doubeurre'], ciqual: '20138' },
  { label: 'navet', names: ['navet'], ciqual: '20064', piece: U(122) },
  { label: 'radis', names: ['radi'], ciqual: '20045', piece: U(4.5) },
  { label: 'betterave', names: ['betterave'], ciqual: '20091', piece: U(82) },
  { label: 'avocat', names: ['avocat'], ciqual: '13004', piece: U(136) },
  { label: 'jus de citron', names: ['jus citron', 'jus citron jaune'], ciqual: '2007', density: U(1.03) },
  { label: 'jus de citron vert', names: ['jus citron vert', 'jus lime'], ciqual: '2030', density: U(1.03) },
  { label: 'gélatine', names: ['gelatine', 'feuille gelatine'], ciqual: '11007', units: { feuille: S(2) }, piece: S(2) },
  { label: 'thym', names: ['thym', 'thym frai'], ciqual: '11070', seasoning: true },
  { label: 'piment', names: ['piment', 'piment rouge', 'piment frai', 'piment vert'], ciqual: '20151', piece: U(45), seasoning: true },
  { label: 'persil', names: ['persil'], ciqual: '11014', seasoning: true },
  { label: 'basilic', names: ['basilic'], ciqual: '11033', seasoning: true },
  { label: 'coriandre', names: ['coriandre'], ciqual: '11094', seasoning: true },
  { label: 'gingembre', names: ['gingembre'], ciqual: '11074', seasoning: true },

  // --- Fruits ----------------------------------------------------------------
  { label: 'banane', names: ['banane'], ciqual: '13005', piece: U(118) },
  { label: 'pomme', names: ['pomme'], ciqual: '13039', piece: U(182) },
  { label: 'poire', names: ['poire'], ciqual: '13037', piece: U(178) },
  { label: 'pêche', names: ['peche'], ciqual: '13043', piece: U(150) },
  { label: 'orange', names: ['orange'], ciqual: '13034', piece: U(131) },
  { label: 'citron', names: ['citron', 'citron jaune'], ciqual: '13009', piece: U(58) },
  { label: 'citron vert', names: ['citron vert', 'lime'], ciqual: '13067', piece: U(67) },
  { label: 'kiwi', names: ['kiwi'], ciqual: '13021', piece: U(69) },
  { label: 'fraise', names: ['fraise'], ciqual: '13014', piece: U(12) },
  { label: 'framboise', names: ['framboise'], ciqual: '13015' },
  { label: 'myrtille', names: ['myrtille'], ciqual: '13028' },
  { label: 'mangue', names: ['mangue'], ciqual: '13025', piece: U(336) },
  { label: 'ananas', names: ['anana'], ciqual: '13002' },
  { label: 'raisin', names: ['raisin'], ciqual: '13395' },
  { label: 'raisin sec', names: ['raisin sec'], ciqual: '13046' },

  // --- Produits laitiers -----------------------------------------------------
  { label: 'lait demi-écrémé', names: ['~lait', 'lait demi ecreme', '~lait vache'], ciqual: '19033', density: U(1.03) },
  { label: 'lait entier', names: ['lait entier'], ciqual: '19016', density: U(1.03) },
  { label: 'crème liquide 30 %', names: ['creme liquide', 'creme entiere', 'creme fleurette', 'creme fluide'], ciqual: '19417', density: U(1.0) },
  { label: 'crème épaisse 30 %', names: ['creme fraiche', 'creme epaisse', 'creme fraiche epaisse', '~creme'], ciqual: '19410', density: E(1.0) },
  { label: 'crème légère', names: ['creme legere', 'creme allegee'], ciqual: '19404' },
  { label: 'beurre doux', names: ['beurre', 'beurre doux'], ciqual: '16400', density: U(0.96) },
  { label: 'beurre demi-sel', names: ['beurre demi sel', 'beurre sale'], ciqual: '16402', density: U(0.96) },
  { label: 'yaourt nature', names: ['yaourt', 'yaourt nature', 'yogourt'], ciqual: '19593', units: { pot: S(125) }, piece: S(125), density: U(1.04) },
  { label: 'fromage blanc', names: ['fromage blanc'], ciqual: '19501', density: U(1.04) },
  { label: 'fromage blanc 0 %', names: ['fromage blanc 0%'], ciqual: '19644', density: U(1.04) },
  { label: 'emmental', names: ['emmental', 'emmenthal', 'fromage rape', 'gruyere rape'], ciqual: '12118', density: U(0.46) },
  { label: 'gruyère', names: ['gruyere'], ciqual: '12114' },
  { label: 'comté', names: ['comte'], ciqual: '12110' },
  { label: 'parmesan', names: ['parmesan', 'parmigiano'], ciqual: '12120', density: U(0.34) },
  { label: 'mozzarella', names: ['mozzarella'], ciqual: '19590', piece: S(125) },
  { label: 'feta', names: ['feta'], ciqual: '12066' },
  { label: 'mascarpone', names: ['mascarpone'], ciqual: '19584' },
  { label: 'ricotta', names: ['ricotta'], ciqual: '19585' },
  { label: 'fromage de chèvre', names: ['chevre', 'fromage chevre', 'buche chevre'], ciqual: '12812' },

  // --- Matières grasses ------------------------------------------------------
  { label: 'huile d’olive', names: ['huile olive'], ciqual: '17270', density: U(0.91) },
  { label: 'huile de tournesol', names: ['~huile', 'huile tournesol', '~huile neutre', '~huile vegetale'], ciqual: '17440', density: U(0.91) },
  { label: 'huile de colza', names: ['huile colza'], ciqual: '17130', density: U(0.91) },

  // --- Sucres, chocolat ------------------------------------------------------
  { label: 'sucre', names: ['sucre', 'sucre blanc', 'sucre poudre', 'sucre semoule'], ciqual: '31016', density: U(0.85) },
  { label: 'sucre glace', names: ['sucre glace'], ciqual: '31016', density: U(0.51) },
  { label: 'sucre roux', names: ['sucre roux', 'cassonade', 'sucre cassonade', 'vergeoise'], ciqual: '31017', density: U(0.85) },
  { label: 'sucre vanillé', names: ['sucre vanille'], ciqual: '31044', units: { sachet: S(7.5) }, density: U(0.85) },
  { label: 'miel', names: ['miel'], ciqual: '31008', density: U(1.42) },
  { label: 'sirop d’érable', names: ['sirop erable'], ciqual: '31034', density: U(1.35) },
  { label: 'cacao en poudre', names: ['cacao', 'cacao poudre', 'cacao non sucre'], ciqual: '18100', density: U(0.37) },
  { label: 'chocolat noir', names: ['~chocolat', '~chocolat noir', '~chocolat patissier', '~chocolat dessert'], ciqual: '31005', units: { carre: S(5) } },
  { label: 'chocolat noir 70 %', names: ['chocolat noir 70', 'chocolat 70'], ciqual: '31074', units: { carre: S(5) } },
  { label: 'chocolat au lait', names: ['chocolat lait'], ciqual: '31004', units: { carre: S(5) } },
  { label: 'chocolat blanc', names: ['chocolat blanc'], ciqual: '31010', units: { carre: S(5) } },

  // --- Farines, féculents ----------------------------------------------------
  { label: 'farine de blé T55', names: ['farine', 'farine ble', 'farine t55', 'farine ble t55'], ciqual: '9436', allow: ['ble', 'tendre', 'froment', 'type'], density: U(0.53) },
  { label: 'farine de blé T45', names: ['farine t45', 'farine patissiere'], ciqual: '9440', allow: ['ble', 'tendre', 'froment', 'type'], density: U(0.53) },
  { label: 'farine de blé T65', names: ['farine t65'], ciqual: '9435', allow: ['ble', 'tendre', 'froment', 'type'], density: U(0.53) },
  { label: 'farine complète T150', names: ['farine complete', 'farine t150', 'farine integrale'], ciqual: '9415', allow: ['ble'], density: U(0.53) },
  { label: 'farine de riz', names: ['farine riz'], ciqual: '9520' },
  { label: 'farine de sarrasin', names: ['farine sarrasin', 'farine ble noir'], ciqual: '9540' },
  { label: 'farine de maïs', names: ['farine mai', 'farine maï'], ciqual: '9545' },
  { label: 'fécule de maïs', names: ['maizena', 'fecule mai', 'amidon mai', 'maïzena'], ciqual: '9510', density: U(0.54) },
  { label: 'fécule de pomme de terre', names: ['fecule', 'fecule pomme terre'], ciqual: '4090' },
  { label: 'flocons d’avoine', names: ['flocon avoine', 'avoine', 'porridge'], ciqual: '32140', density: U(0.34) },
  { label: 'riz blanc cru', names: ['riz', 'riz blanc', 'riz basmati', 'riz thai', 'riz rond'], ciqual: '9100', density: U(0.78) },
  { label: 'riz blanc cuit', names: ['riz cuit', 'riz blanc cuit'], ciqual: '9104' },
  { label: 'pâtes sèches crues', names: ['~pate', '~pates', 'spaghetti', 'tagliatelle', 'penne', 'coquillette', 'macaroni', 'fusilli'], ciqual: '9810' },
  { label: 'pâtes cuites', names: ['pate cuite', 'spaghetti cuit'], ciqual: '9811' },
  { label: 'semoule', names: ['semoule', 'couscous', 'graine couscous'], ciqual: '9610', density: U(0.73) },
  { label: 'quinoa', names: ['quinoa'], ciqual: '9340' },
  { label: 'quinoa cuit', names: ['quinoa cuit'], ciqual: '9341' },
  { label: 'pâte brisée (rouleau)', names: ['~pate brisee', 'pate brisee pur beurre'], ciqual: '23414', piece: S(230) },
  { label: 'pâte feuilletée (rouleau)', names: ['~pate feuilletee', 'pate feuilletee pur beurre'], ciqual: '23424', piece: S(230) },
  { label: 'pâte sablée (rouleau)', names: ['~pate sablee', 'pate sablee pur beurre'], ciqual: '23444', piece: S(230) },
  { label: 'pâte à pizza (rouleau)', names: ['~pate pizza'], ciqual: '37001', piece: E(260) },
  { label: 'chapelure', names: ['chapelure'], ciqual: '7500' },
  { label: 'pain', names: ['pain', 'pain blanc'], ciqual: '7001' },
  { label: 'baguette', names: ['baguette'], ciqual: '7001', piece: S(250) },
  { label: 'pain de mie', names: ['pain mie'], ciqual: '7117', units: { tranche: U(25) } },
  { label: 'lentilles sèches', names: ['lentille', 'lentille verte', 'lentille corail'], ciqual: '20359' },
  { label: 'lentilles cuites', names: ['lentille cuite'], ciqual: '20360' },
  { label: 'pois chiches cuits', names: ['poi chiche'], ciqual: '20532' },
  { label: 'pois chiches secs', names: ['poi chiche sec'], ciqual: '20516' },
  { label: 'haricots rouges cuits', names: ['haricot rouge'], ciqual: '20524' },
  { label: 'haricots blancs cuits', names: ['haricot blanc'], ciqual: '20511' },

  // --- Viandes, poissons -----------------------------------------------------
  { label: 'filet de poulet cru', names: ['~poulet', 'blanc poulet', 'filet poulet', 'escalope poulet', 'aiguillette poulet'], ciqual: '36017', piece: S(120) },
  { label: 'cuisse de poulet crue', names: ['cuisse poulet', 'haut cuisse poulet'], ciqual: '36002' },
  { label: 'poulet entier cru', names: ['poulet entier', 'poulet fermier'], ciqual: '36016' },
  { label: 'escalope de dinde crue', names: ['dinde', 'escalope dinde', 'blanc dinde'], ciqual: '36304', piece: S(120) },
  { label: 'bœuf haché 15 % cru', names: ['~boeuf hache', '~viande hachee', '~steak hache', '~hache boeuf', 'boeuf hache 15%', 'steak hache 15%', 'viande hachee 15%'], ciqual: '6254', piece: S(100) },
  { label: 'jarret de bœuf cru', names: ['jarret boeuf', 'jarret'], ciqual: '6150' },
  { label: 'paleron de bœuf cru', names: ['paleron', 'boeuf braiser', 'boeuf bourguignon'], ciqual: '6270' },
  { label: 'escalope de veau crue', names: ['veau', 'escalope veau'], ciqual: '6521' },
  { label: 'filet mignon de porc cru', names: ['filet mignon', 'filet mignon porc', '~porc'], ciqual: '28204' },
  { label: 'échine de porc crue', names: ['echine porc', 'echine'], ciqual: '28302' },
  { label: 'lardons crus', names: ['lardon'], ciqual: '28501' },
  { label: 'lardons fumés crus', names: ['lardon fume'], ciqual: '28720' },
  { label: 'jambon cuit', names: ['jambon', 'jambon blanc', 'jambon cuit'], ciqual: '28900', units: { tranche: S(40) } },
  { label: 'saumon cru', names: ['saumon', 'pave saumon', 'filet saumon'], ciqual: '26036', piece: S(125) },
  { label: 'thon au naturel', names: ['thon', 'thon naturel', 'thon boite'], ciqual: '26039' },
  { label: 'cabillaud cru', names: ['cabillaud', 'dos cabillaud', 'filet cabillaud'], ciqual: '26043' },
  { label: 'crevettes cuites', names: ['crevette'], ciqual: '10007' },

  // --- Épicerie, condiments --------------------------------------------------
  { label: 'eau', names: ['eau'], ciqual: '18066', density: U(1.0), seasoning: true },
  { label: 'sel', names: ['sel', 'sel fin', 'gros sel', 'fleur sel'], ciqual: '11058', density: U(1.22), units: { pincee: U(0.4) }, seasoning: true },
  { label: 'poivre', names: ['poivre', 'poivre noir'], ciqual: '11015', density: U(0.47), units: { pincee: U(0.4) }, seasoning: true },
  { label: 'moutarde', names: ['moutarde', 'moutarde dijon'], ciqual: '11013', density: U(1.0) },
  { label: 'vinaigre', names: ['vinaigre', 'vinaigre vin', 'vinaigre cidre'], ciqual: '11018', density: U(1.0), seasoning: true },
  { label: 'vinaigre balsamique', names: ['vinaigre balsamique', 'balsamique'], ciqual: '11091', density: U(1.0) },
  { label: 'sauce soja', names: ['sauce soja', 'soja sauce'], ciqual: '11104', density: U(1.08) },
  { label: 'concentré de tomate', names: ['concentre tomate', 'double concentre tomate'], ciqual: '20068', density: U(1.08) },
  { label: 'tomates pelées en conserve', names: ['tomate concassee', 'tomate pelee', 'tomate pelee conserve', 'tomate concassee conserve', 'tomate conserve', 'pulpe tomate'], ciqual: '20137', units: { boite: S(400) } },
  { label: 'coulis de tomate', names: ['coulis tomate', 'puree tomate', 'passata', 'sauce tomate'], ciqual: '20260' },
  { label: 'ketchup', names: ['ketchup'], ciqual: '11008', density: U(1.15) },
  { label: 'mayonnaise', names: ['mayonnaise'], ciqual: '11054', density: U(0.93) },
  { label: 'vin rouge', names: ['vin rouge', '~vin'], ciqual: '5214', density: U(0.99) },
  { label: 'vin blanc', names: ['vin blanc'], ciqual: '5215', density: U(0.99) },
  { label: 'cube de bouillon de bœuf', names: ['cube bouillon', 'bouillon cube', 'cube bouillon boeuf'], ciqual: '11001', units: { cube: S(10) }, piece: S(10) },
  { label: 'cube de bouillon de volaille', names: ['cube bouillon volaille', 'bouillon volaille cube'], ciqual: '11174', units: { cube: S(10) }, piece: S(10) },
  { label: 'cube de bouillon de légumes', names: ['cube bouillon legume'], ciqual: '11041', units: { cube: S(10) }, piece: S(10) },
  { label: 'bouillon de bœuf (liquide)', names: ['bouillon', 'bouillon boeuf'], ciqual: '25930', density: U(1.0) },
  { label: 'bouillon de volaille (liquide)', names: ['bouillon volaille', 'fond volaille'], ciqual: '25947', density: U(1.0) },
  { label: 'bouillon de légumes (liquide)', names: ['bouillon legume'], ciqual: '25948', density: U(1.0) },
  { label: 'levure chimique', names: ['levure chimique', 'poudre lever'], ciqual: '11046', units: { sachet: S(11) }, density: U(0.93) },
  { label: 'levure de boulanger fraîche', names: ['levure boulanger', 'levure fraiche', 'levure boulanger fraiche'], ciqual: '11010' },
  { label: 'levure de boulanger sèche', names: ['levure seche', 'levure boulanger seche', 'levure deshydratee'], ciqual: '11045' },
  { label: 'bicarbonate', names: ['bicarbonate', 'bicarbonate soude'], ciqual: '11507', density: U(0.93), seasoning: true },
  { label: 'curcuma', names: ['curcuma'], ciqual: '11089', density: U(0.6), seasoning: true },
  { label: 'extrait de vanille', names: ['~vanille liquide', '~extrait vanille', '~arome vanille'], ciqual: '11098', density: E(1.0), seasoning: true },
  { label: 'gousse de vanille', names: ['gousse vanille', 'vanille'], ciqual: '11057', seasoning: true },
  { label: 'cannelle', names: ['cannelle'], ciqual: '11025', density: U(0.53), seasoning: true },
  { label: 'curry', names: ['curry'], ciqual: '11005', density: U(0.41), seasoning: true },
  { label: 'cumin', names: ['cumin'], ciqual: '11042', density: U(0.43), seasoning: true },
  { label: 'paprika', names: ['paprika'], ciqual: '11049', density: U(0.47), seasoning: true },
  { label: 'lait de coco', names: ['lait coco'], ciqual: '18041', density: U(0.96) },
  { label: 'beurre de cacahuète', names: ['beurre cacahuete', 'beurre arachide'], ciqual: '15202', density: U(1.08) },
  { label: 'noix', names: ['noix', 'cerneau noix'], ciqual: '15005' },
  { label: 'noisette', names: ['noisette'], ciqual: '15004' },
  { label: 'amande', names: ['amande', 'amande emondee', 'poudre amande', 'amande poudre', 'amande effilee'], ciqual: '15041', density: U(0.4) },
  { label: 'noix de coco râpée', names: ['noix coco rapee', 'coco rapee', 'noix coco sechee'], ciqual: '15007' },
  { label: 'noix de cajou', names: ['noix cajou', 'cajou'], ciqual: '15054' },
]

/** Poids génériques par unité, quand l'ingrédient n'a pas de valeur propre (pincée USDA ≈ 0,36–0,4 g). */
export const GENERIC_UNIT_WEIGHTS: Record<string, UsualWeight> = {
  pincee: U(0.4),
}

/** Facteurs indicatifs pour « petit » / « gros » (ordre de grandeur des portions USDA). */
export const SIZE_FACTORS = { small: 0.7, large: 1.35 }

export const SOURCE_LABEL: Record<WeightSource, string> = {
  usda: 'portion de référence USDA',
  usage: 'contenance usuelle',
  estimate: 'ordre de grandeur',
}

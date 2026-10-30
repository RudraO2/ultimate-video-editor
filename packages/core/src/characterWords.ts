// Words that name the parts of a character, per role, in many languages, for
// `character.detect`. Data, ported from AtomCut's lists (with permission, see
// CLAUDE.md "Reverse engineering AtomCut"); the matching code is our own.
// Entries are separated by "|"; a few are two words ("upper arm"). Accents and
// case do not matter: both sides go through `nameTokens` before comparing.

export const BASE_ROLES = ['head', 'face', 'hair', 'brow', 'eye', 'lid', 'pupil', 'nose', 'mouth', 'neck', 'torso', 'hips', 'arm', 'forearm', 'hand', 'leg', 'shin', 'foot', 'accessory'] as const
export type BaseRole = (typeof BASE_ROLES)[number]

/** Roles that come in a left and a right one. */
export const SIDED_ROLES: readonly BaseRole[] = ['brow', 'eye', 'lid', 'pupil', 'arm', 'forearm', 'hand', 'leg', 'shin', 'foot']

export const ROLE_WORDS: Record<BaseRole, string> = {
  head: 'head|kopf|cabeza|tete|testa|cabeca|голова|頭|头|あたま|머리|سر|رأس|kafa|hoofd|glowa',
  face: 'face|facial|gesicht|cara|rostro|visage|viso|rosto|лицо|顔|脸|かお|얼굴|صورت|چهره|وجه|yuz|gezicht',
  eye: 'eye|eyeball|eye ball|auge|ojo|oeil|œil|occhio|olho|глаз|目|眼|め|눈|چشم|عين|goz|oog|oko',
  pupil: 'pupil|iris|pupille|pupila|pupilla|зрачок|瞳|瞳孔|黒目|눈동자|مردمک|بؤبؤ|goz bebegi',
  lid: 'lid|eyelid|eye lid|blink|augenlid|lid oben|parpado|paupiere|palpebra|веко|まぶた|瞼|眼皮|눈꺼풀|پلک|جفن',
  brow: 'brow|eyebrow|augenbraue|ceja|sourcil|sopracciglio|sobrancelha|бровь|眉|眉毛|まゆ|눈썹|ابرو|حاجب|kas',
  mouth: 'mouth|lips|lip|mund|boca|bouche|bocca|рот|口|嘴|くち|입|دهان|دهن|فم|agiz|mond|usta',
  nose: 'nose|nase|nariz|nez|naso|нос|鼻|はな|코|بینی|دماغ|انف|burun|neus',
  neck: 'neck|hals|cuello|cou|collo|pescoco|шея|首|脖子|목|گردن|رقبة|boyun|nek',
  torso: 'torso|body|chest|trunk|spine|rumpf|korper|cuerpo|pecho|corps|buste|corpo|тело|туловище|体|胴|身体|躯干|몸|بدن|تنه|جسم|govde|lichaam|shirt',
  hips: 'hips|hip|pelvis|waist|hufte|cadera|hanche|bacino|quadril|таз|腰|骨盤|엉덩이|لگن|pants|skirt',
  arm: 'arm|upper arm|upperarm|oberarm|brazo|bras|braccio|braco|рука|плечо|腕|上腕|胳膊|팔|بازو|ذراع|kol|sleeve',
  forearm: 'forearm|lower arm|unterarm|antebrazo|avant bras|前腕|前臂|предплечье|ساعد',
  hand: 'hand|mano|main|mao|кисть|ладонь|手|손|دست|يد|glove|palm',
  leg: 'leg|thigh|bein|pierna|muslo|jambe|cuisse|gamba|coscia|perna|coxa|нога|бедро|脚|腿|다리',
  shin: 'shin|calf|lower leg|knee|tibia|mollet|canela|голень|すね|小腿',
  foot: 'foot|shoe|boot|fuss|pie|pied|piede|ступня|стопа|足|발|پا|ayak|voet|sneaker',
  hair: 'hair|fringe|bangs|ponytail|haare|pelo|cabello|cheveux|capelli|cabelo|волосы|髪|头发|머리카락|مو|شعر',
  accessory: 'accessory|accessories|accessoires|accesorios|hat|cap|glasses|sunglasses|scarf|earring|bow tie|necklace|crown|helmet|mask|prop|hut|sombrero|chapeau|帽子|眼鏡|メガネ|모자|안경|قبعة|نظارة',
}

/** Names of several parts: they count only for the layers inside (a group "Eyes" holds the two eyes). */
export const PLURAL_WORDS: Partial<Record<BaseRole, string>> = {
  eye: 'eyes|augen|ojos|yeux|occhi|olhos|глаза|ogen|oczy',
  brow: 'brows|eyebrows|augenbrauen|cejas|sourcils|sopracciglia|sobrancelhas|брови',
  pupil: 'pupils|pupilas|pupille|pupilles',
  lid: 'lids|eyelids',
  arm: 'arms|arme|brazos',
  hand: 'hands|hande|manos|mains|mani|maos|руки',
  leg: 'legs|beine|piernas|jambes|gambe|pernas',
  foot: 'feet|shoes|fusse|pies|pieds|piedi',
}

/** The character's left is the screen's right. */
export const LEFT_WORDS =
  'l|left|lft|lt|links|linker|linke|izquierdo|izquierda|izq|gauche|sinistro|sinistra|sx|esquerdo|esquerda|левый|левая|левое|лев|ひだり|왼쪽|왼|چپ|يسار|ايسر|sol|lewy|lewa'
export const RIGHT_WORDS =
  'r|right|rgt|rt|rechts|rechter|rechte|derecho|derecha|der|droite|droit|destro|destra|dx|direito|direita|правый|правая|правое|прав|みぎ|오른쪽|오른|راست|يمين|ايمن|sag|prawy|prawa'

/** Words that mark a duplicate: the side in such a name is stale and ignored. */
export const COPY_WORDS = ['copy', 'kopie', 'copia', 'copie', 'копия', 'コピー']

/** Mouth shapes (visemes) in the vocabularies animators use: ours, Rhubarb's letters, Character Animator's, Preston Blair's. */
export const VISEME_NAMES = [
  'x', 'mbp', 's', 'e', 'ai', 'o', 'u', 'fv', 'l', 'a', 'b', 'c', 'd', 'f', 'g', 'h',
  'neutral', 'ah', 'ee', 'm', 'oh', 'r', 'uh', 'woo', 'rest', 'etc', 'wq',
]

/** Names of the drawings of an eye. */
export const EYE_STATE_OPEN = ['open', 'opened', 'awake']
export const EYE_STATE_SHUT = ['closed', 'close', 'shut', 'blink', 'half', 'halfclosed', 'halfopen', 'squint']

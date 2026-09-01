'use strict';

// ---------------------------------------------------------------------------
// Datos de ejemplo del seed (genéricos, sin personajes reales).
//
// Los datos personales NO se versionan: van en character_data.local.js (ignorado
// por git) y tienen prioridad si existe — ver loadCharacterData() en seed.js.
// ---------------------------------------------------------------------------

// Prefijo/sufijo de calidad y negativos aplicados a TODO prompt, independiente del
// personaje — es la misma idea que CHARACTERS/ACCESSORIES/FRAMINGS: datos puros de
// prompt, sin nada de configuración de generación (eso vive en los presets).
export const GLOBAL_POSITIVE =
  'masterpiece, best quality, photorealistic, cinematic lighting, sharp focus, natural skin texture, natural eyes, realistic iris texture';

export const GLOBAL_NEGATIVE =
  'worst quality, low quality, blurry, deformed, bad anatomy, extra limbs, extra fingers, ' +
  'asymmetrical face, asymmetrical eyes, crossed eyes, doll eyes, glassy eyes, watermark, text, anime, cartoon, 3d render, multiple people';

export const CHARACTERS = {

  sample_woman: {
    identity: '1woman, young woman, mid 20s, fair skin, average build, oval face',
    face: 'dark brown almond eyes, soft cheekbones, straight nose, full lips',
    hair: 'shoulder-length wavy brown hair, natural side part',
    body: 'average build, feminine silhouette',
    lighting: 'soft natural light',
    negative_identity: 'male, man, beard, mustache, long hair, earrings, heavy makeup, aging signs, scars',
    expressions: {
      normal: {
        positive: '(neutral expression:1.3), mouth softly closed, calm steady gaze',
        negative: 'smile, smiling, frown',
      },
      happy: {
        positive: '(happy expression:1.3), gentle smile, relaxed brows, warm gaze',
        negative: 'frown, sad, crying',
      },
      serious: {
        positive: '(serious expression:1.3), lips pressed closed, focused gaze, calm resolve',
        negative: 'smile, smiling, laughing',
      },
    },
    outfits: {
      base: 'plain white t-shirt, jeans',
      casual: {
        positive: 'light grey hoodie, plain t-shirt underneath, blue jeans, sneakers, fully clothed, casual everyday look',
        negative: 'exposed skin, open jacket, bare midriff, bare chest, bare legs, unbuttoned, shorts, short skirt',
      },
      formal: {
        positive: 'dark navy blazer, white button-up shirt, tailored trousers, fully clothed, business formal look',
        negative: 'exposed skin, open jacket, bare midriff, bare legs, casual clothes, t-shirt, hoodie',
      },
    },
  },

  sample_man: {
    identity: '1man, young man, early 30s, tan skin, athletic build, square jaw',
    face: 'brown eyes, defined cheekbones, straight nose, thin lips, light stubble',
    hair: 'short dark hair, natural side part',
    body: 'athletic build, broad shoulders',
    lighting: 'soft natural light',
    negative_identity: 'female, woman, feminine features, long hair, earrings, makeup, breasts, aging signs, scars',
    expressions: {
      normal: {
        positive: '(neutral expression:1.3), mouth softly closed, calm steady gaze',
        negative: 'smile, smiling, frown',
      },
      happy: {
        positive: '(happy expression:1.3), broad smile, relaxed brows, friendly gaze',
        negative: 'frown, sad, angry',
      },
      serious: {
        positive: '(serious expression:1.3), jaw set, focused gaze, lips closed',
        negative: 'smile, smiling, laughing',
      },
    },
    outfits: {
      base: 'plain grey t-shirt, jeans',
      casual: {
        positive: 'dark grey zip-up hoodie, plain white t-shirt underneath, jeans, fully clothed, casual everyday look',
        negative: 'exposed skin, open jacket, bare midriff, bare chest, bare legs, unbuttoned, shorts',
      },
      formal: {
        positive: 'charcoal suit jacket, white button-up shirt, dark trousers, fully clothed, business formal look',
        negative: 'exposed skin, open jacket, bare midriff, bare chest, casual clothes, t-shirt, hoodie',
      },
    },
  },

  sample_teen: {
    identity: '1girl, teenager, late teens, fair skin, slim build, round face',
    face: 'dark eyes, soft features, small nose, thin lips',
    hair: 'straight black hair, simple straight cut',
    body: 'slim build, average height',
    lighting: 'soft natural light',
    negative_identity: 'adult, mature woman, wrinkles, heavy makeup, tattoos, scars',
    expressions: {
      normal: {
        positive: '(neutral expression:1.3), mouth softly closed, calm gaze',
        negative: 'smile, smiling, frown',
      },
      happy: {
        positive: '(happy expression:1.3), bright smile, cheerful gaze',
        negative: 'frown, sad, crying',
      },
      shy: {
        positive: '(shy expression:1.3), slight blush, averted gaze, small smile',
        negative: 'confident, angry, frowning',
      },
    },
    outfits: {
      base: 'plain pastel t-shirt, denim skirt',
      school: {
        positive: 'school uniform, white shirt, pleated navy skirt, fully clothed, neat appearance',
        negative: 'exposed skin, short skirt, bare midriff, casual clothes, unbuttoned',
      },
      sporty: {
        positive: 'sports jacket, plain t-shirt, track pants, sneakers, fully clothed, athletic casual look',
        negative: 'exposed skin, bare midriff, bare legs, formal clothes',
      },
    },
  },

};

export const ACCESSORIES = {
  glasses: {
    positive: 'thin-framed glasses, rectangular or round frames, wearing glasses, clearly visible on face',
    negative: 'sunglasses, no glasses',
  },
  hat: {
    positive: 'simple knit beanie, snug fitting hat, wearing a hat',
    negative: 'bareheaded, cap, wide-brimmed hat',
  },
  necklace: {
    positive: 'thin delicate necklace, simple chain at collarbone, minimal jewelry',
    negative: 'choker, chunky necklace, pendant',
  },
};

export const FRAMINGS = {
  portrait: {
    positive: 'portrait photo, face fills frame, looking at camera, face centered and high in frame, top of head visible, chin visible, soft studio lighting, white screen background',
    negative: 'full body, small face, face too low, cropped forehead, hair cut off, head cut off, looking away, (side profile:1.4), tilted head, three quarter view, turned head, face turned, angled face, one eye hidden, body visible below chest',
  },
  bust: {
    positive: 'upper body shot, head and torso visible, waist up, white screen background',
    negative: 'full body, legs visible, feet visible, head cut off, cropped head',
  },
  three_quarters: {
    positive: '(three-quarter body shot:1.5), full head visible at top of frame, head to knees, (legs visible:1.3), thighs visible, (knees visible:1.3), (standing upright:1.5), (straight posture:1.5), (facing camera:1.3), (perfect hands:1.4), (hands on sides:1.4), (green screen background:1.3)',
    negative: 'head cut off, cropped head, missing top of head, upper body only, cropped at waist, missing legs, missing knees, leaning forward, bending, slouching, sitting, crouching, kneeling, tilted body, (side profile:1.4), turned body, angled body, one leg hidden',
  },
  full_body: {
    positive: 'full body shot, entire body visible, head to feet, legs fully visible, feet visible, standing upright, (perfect hands:1.4), (hands on sides:1.4), green screen background',
    negative: 'upper body only, cropped at waist, cropped at thighs, cropped at knees, missing legs, missing feet, sitting, crouching',
  },
};

const fallbackMenuFilters = {
  eventTypes: ['Банкет', 'Фуршет', 'Кофе-брейк'],
  dishClasses: [
    'Канапе',
    'Холодные закуски',
    'Салаты',
    'Десерты',
    'Горячие закуски',
    'Горячие блюда',
    'Завтраки',
    'Детское меню',
    'Сэндвичи',
    'Круассаны',
    'Выпечка',
    'Обед',
    'Супы',
    'Снеки'
  ]
};

function getNocoDbConfig() {
  return {
    baseUrl: process.env.NOCODB_BASE_URL,
    token: process.env.NOCODB_TOKEN,
    tableId: process.env.NOCODB_TABLE_ID,
    typeField: process.env.NOCODB_TYPE_EVENT_FIELD || 'type_event',
    classField: process.env.NOCODB_CLASS_DISH_FIELD || 'class_dish',
    photoField: process.env.NOCODB_PHOTO_STATUS_FIELD || 'photo_status',
    emptyPhotoValue: process.env.NOCODB_PHOTO_STATUS_EMPTY_VALUE || '',
    dishNameField: process.env.NOCODB_DISH_NAME_FIELD || 'specific_dish'
  };
}

async function fetchNocoDbRecords({ where, limit = 1000 } = {}) {
  const { baseUrl, token, tableId } = getNocoDbConfig();
  if (!baseUrl || !token || !tableId) return null;

  const url = new URL(`/api/v2/tables/${tableId}/records`, baseUrl);
  url.searchParams.set('limit', String(limit));
  if (where) url.searchParams.set('where', where);

  const response = await fetch(url, {
    headers: {
      'xc-token': token
    }
  });

  if (!response.ok) {
    throw new Error(`NocoDB request failed: ${response.status}`);
  }
  const data = await response.json();
  return data.list || data.records || [];
}

export async function fetchMenuFilters() {
  const { typeField, classField } = getNocoDbConfig();
  const records = await fetchNocoDbRecords();
  if (!records) return fallbackMenuFilters;

  const unique = (field) => [...new Set(records.map((record) => record[field]).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), 'ru'));

  return {
    eventTypes: unique(typeField),
    dishClasses: unique(classField)
  };
}

export async function fetchMissingPhotoDishes({ typeEvent, classDish }) {
  const { baseUrl, token, tableId, typeField, classField, photoField, emptyPhotoValue, dishNameField } = getNocoDbConfig();

  if (!baseUrl || !token || !tableId) {
    return [
      {
        id: 'demo-1',
        name: 'Канапе с ростбифом',
        type_event: typeEvent || 'Банкет',
        class_dish: classDish || 'Канапе',
        photo_status: 'нет фото'
      },
      {
        id: 'demo-2',
        name: 'Мини-брускетта с томатами',
        type_event: typeEvent || 'Фуршет',
        class_dish: classDish || 'Холодные закуски',
        photo_status: 'нет фото'
      }
    ];
  }

  if (!typeEvent || !classDish) {
    return [];
  }

  const where = `(${typeField},eq,${typeEvent})~and(${classField},eq,${classDish})~and(${photoField},eq,${emptyPhotoValue})`;
  const records = await fetchNocoDbRecords({ where, limit: 25 });
  return records.map((record) => ({
    ...record,
    id: record.id || record.Id,
    name: record.name || record.Name || record.title || record[dishNameField],
    type_event: record.type_event || record[typeField],
    class_dish: record.class_dish || record[classField],
    photo_status: record.photo_status || record[photoField]
  }));
}

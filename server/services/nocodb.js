export async function fetchMissingPhotoDishes({ typeEvent, classDish }) {
  const baseUrl = process.env.NOCODB_BASE_URL;
  const token = process.env.NOCODB_TOKEN;
  const tableId = process.env.NOCODB_TABLE_ID;

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

  const typeField = process.env.NOCODB_TYPE_EVENT_FIELD || 'type_event';
  const classField = process.env.NOCODB_CLASS_DISH_FIELD || 'class_dish';
  const photoField = process.env.NOCODB_PHOTO_STATUS_FIELD || 'photo_status';
  const emptyPhotoValue = process.env.NOCODB_PHOTO_STATUS_EMPTY_VALUE || '';
  const dishNameField = process.env.NOCODB_DISH_NAME_FIELD || 'specific_dish';
  const where = `(${typeField},eq,${typeEvent})~and(${classField},eq,${classDish})~and(${photoField},eq,${emptyPhotoValue})`;

  const url = new URL(`/api/v2/tables/${tableId}/records`, baseUrl);
  url.searchParams.set('where', where);
  url.searchParams.set('limit', '25');

  const response = await fetch(url, {
    headers: {
      'xc-token': token
    }
  });

  if (!response.ok) {
    throw new Error(`NocoDB request failed: ${response.status}`);
  }
  const data = await response.json();
  const records = data.list || data.records || [];
  return records.map((record) => ({
    ...record,
    id: record.id || record.Id,
    name: record.name || record.Name || record.title || record[dishNameField],
    type_event: record.type_event || record[typeField],
    class_dish: record.class_dish || record[classField],
    photo_status: record.photo_status || record[photoField]
  }));
}

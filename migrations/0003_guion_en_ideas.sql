-- Detalle de la propuesta y guion de cada idea.
-- (El Worker también añade estas columnas solo si faltan; este archivo queda como referencia.)
ALTER TABLE ideas ADD COLUMN detalle TEXT NOT NULL DEFAULT '';
ALTER TABLE ideas ADD COLUMN guion TEXT NOT NULL DEFAULT '';
ALTER TABLE ideas ADD COLUMN guion_en TEXT;
ALTER TABLE ideas ADD COLUMN storyboard TEXT;
ALTER TABLE ideas ADD COLUMN fliki TEXT;
ALTER TABLE ideas ADD COLUMN paquete TEXT;

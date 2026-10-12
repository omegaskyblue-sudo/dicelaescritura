-- Detalle de la propuesta y guion de cada idea.
-- (El Worker también añade estas columnas solo si faltan; este archivo queda como referencia.)
ALTER TABLE ideas ADD COLUMN detalle TEXT NOT NULL DEFAULT '';
ALTER TABLE ideas ADD COLUMN guion TEXT NOT NULL DEFAULT '';
ALTER TABLE ideas ADD COLUMN guion_en TEXT;
ALTER TABLE ideas ADD COLUMN storyboard TEXT;
ALTER TABLE ideas ADD COLUMN fliki TEXT;
ALTER TABLE ideas ADD COLUMN paquete TEXT;
ALTER TABLE ideas ADD COLUMN formato TEXT NOT NULL DEFAULT 'largo';
ALTER TABLE ideas ADD COLUMN serie TEXT NOT NULL DEFAULT '';
ALTER TABLE ideas ADD COLUMN padre_id INTEGER;
ALTER TABLE ideas ADD COLUMN publicar_en TEXT;

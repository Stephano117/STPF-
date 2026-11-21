-- Suppression de la notion de service : trois espaces (entreprise, partagés, personnel) suffisent.
-- Les anciens dossiers de service deviennent des dossiers communs ; aucun document n'est touché.
ALTER TABLE "Folder" DROP COLUMN "departmentId";
ALTER TABLE "User" DROP COLUMN "departmentId";
ALTER TABLE "User" DROP COLUMN "jobTitle";
DROP TABLE "Department";

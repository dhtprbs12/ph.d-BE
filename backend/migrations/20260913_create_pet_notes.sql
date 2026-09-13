-- Create pet_notes table for Nom Nom Notes feature
CREATE TABLE IF NOT EXISTS pet_notes (
  id VARCHAR(36) PRIMARY KEY,
  pet_id VARCHAR(36) NOT NULL,
  date DATE NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pet_notes_date (pet_id, date),
  FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
);
